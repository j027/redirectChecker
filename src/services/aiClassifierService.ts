import * as onnx from "onnxruntime-node";
import { promises as fs } from "fs";
import { Browser } from "patchright";
import path from "path";
import pool from "../dbPool.js";
import {
  spoofWindowsChrome,
  blockGoogleAnalytics,
  parseProxy,
} from "../utils/playwrightUtilities.js";
import crypto from "crypto";
import sharp from "sharp";
import { BrowserManagerService } from './browserManagerService.js';

// Constants for the model
const INPUT_WIDTH = 1280;
const INPUT_HEIGHT = 1280;
const CONFIDENCE_THRESHOLD = 0.7;

const MODEL_VERSIONS = {
  IMAGE: "v0.0.2",
  HTML: "v0.0.1",
};

interface ClassificationResult {
  isScam: boolean;
  confidenceScore: number;
  screenshot: Buffer;
  html: string;
  url: string;
}

export class AiClassifierService {
  private model: onnx.InferenceSession | null = null;
  private browser: Browser | null = null;
  private browserInitializing: boolean = false;

  async init() {
    try {
      await this.ensureBrowserIsHealthy();

      // Load the ONNX model
      const modelPath = path.join(
        process.cwd(),
        "models",
        "image_scam_detector.onnx"
      );
      this.model = await onnx.InferenceSession.create(modelPath);

      // Update training dataset on startup
      await this.updateTrainingDataset();
    } catch (error) {
      console.error("Error initializing AI Classifier:", error);
      throw error;
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private async ensureBrowserIsHealthy(): Promise<void> {
    await BrowserManagerService.ensureBrowserHealth(
      this.browser,
      this.browserInitializing,
      async () => {
        try {
          this.browserInitializing = true;
          
          // Close existing browser if any
          await BrowserManagerService.closeBrowser(this.browser);
          
          // Create new browser
          this.browser = await BrowserManagerService.createBrowser(false);
          console.log("Browser report service initialized new browser");
        } finally {
          this.browserInitializing = false;
        }
      }
    );
  }

  async classifyUrl(url: string): Promise<ClassificationResult | null> {
    await this.ensureBrowserIsHealthy();

    if (!this.browser || !this.model) {
      console.error("Browser or model not initialized");
      return null;
    }

    // Setup page and navigation
    const context = await this.browser.newContext({
      proxy: await parseProxy(true),
      viewport: null,
    });
    const page = await context.newPage();
    await blockGoogleAnalytics(page);

    try {
      await spoofWindowsChrome(context, page);
      await page.goto(url);

      await page.mouse.click(0, 0);

      // Capture screenshot and HTML
      const screenshot = await page.screenshot();
      const html = await page.content();
      const currentUrl = page.url();

      // Process the image for the model
      const prediction = await this.runInference(screenshot);
      const isScam = prediction.isScam;
      const confidenceScore = prediction.confidenceScore;

      // Save data regardless of classification
      await this.saveData(
        currentUrl,
        screenshot,
        html,
        isScam,
        confidenceScore
      );

      // Log prediction details
      const confidencePercent = (confidenceScore * 100).toFixed(2);
      if (confidenceScore >= CONFIDENCE_THRESHOLD) {
        console.log(
          `✅ Confident Prediction for ${currentUrl}: ${isScam ? "SCAM" : "NON_SCAM"} | Confidence: ${confidencePercent}%`
        );
      } else {
        console.log(
          `⚠️ Low Confidence Prediction for ${currentUrl}: ${isScam ? "SCAM" : "NON_SCAM"} | Confidence: ${confidencePercent}%`
        );
      }

      return {
        isScam,
        confidenceScore,
        screenshot,
        html,
        url: currentUrl,
      };
    } catch (error) {
      console.error(`Error classifying URL ${url}:`, error);
      return null;
    } finally {
      await page.close();
      await context.close();
    }
  }

  public async runInference(
    imageBuffer: Buffer
  ): Promise<{ isScam: boolean; confidenceScore: number }> {
    try {
      // Log start of inference
      console.log("Starting inference for image");

      // Preprocess the image
      const preprocessedImage = await this.preprocessImage(imageBuffer);

      // Create input tensor with correct dimensions
      const inputTensor = new onnx.Tensor("float32", preprocessedImage, [
        1,
        3,
        INPUT_HEIGHT,
        INPUT_WIDTH,
      ]);

      // Get dynamic input name
      const inputName = this.model!.inputNames[0];
      console.log(`Using model input name: ${inputName}`);

      // Run inference
      const feeds = { [inputName]: inputTensor };
      const results = await this.model!.run(feeds);

      // Get dynamic output name
      const outputName = this.model!.outputNames[0];
      console.log(`Using model output name: ${outputName}`);

      // Process output tensor
      const output = results[outputName].data as Float32Array;
      console.log("Raw output:", Array.from(output));

      // Find the class with highest confidence
      let maxConfidenceIdx = 0;
      let maxConfidence = output[0];

      for (let i = 1; i < output.length; i++) {
        if (output[i] > maxConfidence) {
          maxConfidence = output[i];
          maxConfidenceIdx = i;
        }
      }

      // Map to class (0 = non_scam, 1 = scam)
      const isScam = maxConfidenceIdx === 1;
      const confidenceScore = maxConfidence;

      console.log(
        `Prediction: class=${maxConfidenceIdx} (${isScam ? "scam" : "non_scam"}), confidence=${confidenceScore}`
      );

      return { isScam, confidenceScore };
    } catch (error) {
      console.error("Error during model inference:", error);
      return { isScam: false, confidenceScore: 0 };
    }
  }

  private async preprocessImage(imageBuffer: Buffer): Promise<Float32Array> {
    try {
      // Resize and normalize the image using sharp
      const processedBuffer = await sharp(imageBuffer)
        .resize(INPUT_WIDTH, INPUT_HEIGHT)
        .removeAlpha()
        .raw()
        .toBuffer();

      // Create tensor with proper dimensions
      const pixelCount = INPUT_WIDTH * INPUT_HEIGHT;
      const tensorData = new Float32Array(3 * pixelCount);

      // Convert from interleaved RGB to planar CHW format
      for (let i = 0; i < pixelCount; i++) {
        // Sharp gives pixels in interleaved RGB format (R,G,B,R,G,B,...)
        const r = processedBuffer[i * 3] / 255.0; // R value
        const g = processedBuffer[i * 3 + 1] / 255.0; // G value
        const b = processedBuffer[i * 3 + 2] / 255.0; // B value

        // Store in CHW format (all R values, then all G values, then all B values)
        tensorData[i] = r; // R channel
        tensorData[i + pixelCount] = g; // G channel
        tensorData[i + 2 * pixelCount] = b; // B channel
      }

      return tensorData;
    } catch (error) {
      console.error("Error in preprocessImage:", error);
      throw error;
    }
  }

  public async saveData(
    url: string,
    screenshot: Buffer,
    html: string,
    isScam: boolean,
    confidenceScore: number
  ): Promise<void> {
    const client = await pool.connect();

    try {
      // Check if URL already exists in the dataset
      const checkResult = await client.query(
        "SELECT 1 FROM url_training_dataset WHERE url = $1",
        [url]
      );

      // If record already exists, abort
      if (checkResult.rows.length > 0) {
        console.log(`URL ${url} already exists in training dataset - skipping`);
        return;
      }

      // Continue with saving new data
      const uuid = crypto.randomUUID();

      // Ensure directories exist
      const screenshotDir = path.join(
        process.cwd(),
        "data",
        "screenshots",
        isScam ? "scam" : "non_scam"
      );
      const htmlDir = path.join(
        process.cwd(),
        "data",
        "html",
        isScam ? "scam" : "non_scam"
      );

      await fs.mkdir(screenshotDir, { recursive: true });
      await fs.mkdir(htmlDir, { recursive: true });

      // Insert into database
      await client.query(
        "INSERT INTO url_training_dataset (uuid, url, is_scam, confidence_score, model_type, model_version) VALUES ($1, $2, $3, $4, $5, $6)",
        [uuid, url, isScam, confidenceScore, "IMAGE", MODEL_VERSIONS.IMAGE]
      );

      // Save to filesystem
      await fs.writeFile(path.join(screenshotDir, `${uuid}.png`), screenshot);
      await fs.writeFile(path.join(htmlDir, `${uuid}.html`), html);

      console.log(
        `Saved classification data for ${url} (${isScam ? "scam" : "non_scam"}, confidence: ${confidenceScore.toFixed(4)})`
      );
    } catch (error) {
      console.error(`Error saving classification data for ${url}:`, error);
    } finally {
      client.release();
    }
  }

  /**
   * Updates all training dataset entries that have outdated model versions
   * or missing confidence scores by running the latest model against them.
   */
  async updateTrainingDataset(): Promise<void> {
    console.log("Starting training dataset update...");

    if (!this.model) {
      console.error("Model not initialized, cannot update training dataset");
      return;
    }

    const client = await pool.connect();

    try {
      // Find entries that need updating
      const needsUpdateQuery = await client.query(
        `
        SELECT uuid, url, is_scam, model_type, model_version 
        FROM url_training_dataset 
        WHERE model_version != $1 
           OR confidence_score IS NULL
        ORDER BY created_at DESC
      `,
        [MODEL_VERSIONS.IMAGE]
      );

      console.log(
        `Found ${needsUpdateQuery.rows.length} entries that need updating`
      );

      // Process each entry
      for (const entry of needsUpdateQuery.rows) {
        console.log(`Processing entry ${entry.uuid} (${entry.url})`);

        try {
          // Prepare filesystem paths
          const oldLabel = entry.is_scam ? "scam" : "non_scam";
          const oldScreenshotPath = path.join(
            process.cwd(),
            "data",
            "screenshots",
            oldLabel,
            `${entry.uuid}.png`
          );
          const oldHtmlPath = path.join(
            process.cwd(),
            "data",
            "html",
            oldLabel,
            `${entry.uuid}.html`
          );

          // Load existing assets
          let screenshot: Buffer;
          let html: string;

          try {
            screenshot = await fs.readFile(oldScreenshotPath);
            html = await fs.readFile(oldHtmlPath, "utf8");
          } catch (fileError) {
            console.error(
              `Cannot find files for ${entry.uuid}, will reclassify URL`
            );

            // If files are missing, reclassify from URL
            const result = await this.classifyUrl(entry.url);
            if (!result) {
              console.error(`Failed to reclassify URL ${entry.url}, skipping`);
              continue;
            }

            // Update database with new classification
            await client.query(
              `
              UPDATE url_training_dataset
              SET is_scam = $1, 
                  confidence_score = $2, 
                  model_version = $3,
                  last_updated = CURRENT_TIMESTAMP
              WHERE uuid = $4
            `,
              [
                result.isScam,
                result.confidenceScore,
                MODEL_VERSIONS.IMAGE,
                entry.uuid,
              ]
            );

            console.log(
              `Reclassified URL ${entry.url} as ${result.isScam ? "scam" : "non_scam"} with confidence ${result.confidenceScore.toFixed(4)}`
            );
            continue;
          }

          // Run inference with current model
          const prediction = await this.runInference(screenshot);
          const newLabel = prediction.isScam ? "scam" : "non_scam";

          // Update the database
          await client.query(
            `
            UPDATE url_training_dataset
            SET is_scam = $1, 
                confidence_score = $2, 
                model_version = $3,
                last_updated = CURRENT_TIMESTAMP
            WHERE uuid = $4
          `,
            [
              prediction.isScam,
              prediction.confidenceScore,
              MODEL_VERSIONS.IMAGE,
              entry.uuid,
            ]
          );

          // If classification changed, move files to new location
          if (oldLabel !== newLabel) {
            // Create new directories if needed
            const newScreenshotDir = path.join(
              process.cwd(),
              "data",
              "screenshots",
              newLabel
            );
            const newHtmlDir = path.join(
              process.cwd(),
              "data",
              "html",
              newLabel
            );

            await fs.mkdir(newScreenshotDir, { recursive: true });
            await fs.mkdir(newHtmlDir, { recursive: true });

            // Move files
            const newScreenshotPath = path.join(
              newScreenshotDir,
              `${entry.uuid}.png`
            );
            const newHtmlPath = path.join(newHtmlDir, `${entry.uuid}.html`);

            await fs.writeFile(newScreenshotPath, screenshot);
            await fs.writeFile(newHtmlPath, html);

            // Remove old files
            await fs.unlink(oldScreenshotPath);
            await fs.unlink(oldHtmlPath);

            console.log(
              `Moved files for ${entry.uuid} from ${oldLabel} to ${newLabel}`
            );
          }

          console.log(
            `Updated entry ${entry.uuid} as ${prediction.isScam ? "scam" : "non_scam"} with confidence ${prediction.confidenceScore.toFixed(4)}`
          );
        } catch (entryError) {
          console.error(`Error processing entry ${entry.uuid}:`, entryError);
        }
      }

      console.log("Training dataset update completed");
    } catch (error) {
      console.error("Error updating training dataset:", error);
    } finally {
      client.release();
    }
  }
}

export const aiClassifierService = new AiClassifierService();
