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
const INPUT_WIDTH = 224;
const INPUT_HEIGHT = 224;
const CONFIDENCE_THRESHOLD = 0.90;

// ImageNet normalization constants
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

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
        "scam_classifier.onnx"
      );
      this.model = await onnx.InferenceSession.create(modelPath);
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
          console.log("AI classifier service initialized new browser");
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
      console.log("Raw output (logits):", Array.from(output));

      // Apply softmax to convert logits to probabilities
      const maxLogit = Math.max(...Array.from(output));
      const expValues = Array.from(output).map(x => Math.exp(x - maxLogit));
      const sumExp = expValues.reduce((a, b) => a + b, 0);
      const probabilities = expValues.map(x => x / sumExp);
      
      console.log("Probabilities after softmax:", probabilities);

      // Find the class with highest probability
      let maxConfidenceIdx = 0;
      let maxConfidence = probabilities[0];

      for (let i = 1; i < probabilities.length; i++) {
        if (probabilities[i] > maxConfidence) {
          maxConfidence = probabilities[i];
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
      // Resize to 256, then center crop to 224 (matching training transforms)
      const resized = await sharp(imageBuffer)
        .resize(256, 256)
        .removeAlpha()
        .raw()
        .toBuffer();

      // Center crop from 256x256 to 224x224
      const cropOffset = Math.floor((256 - INPUT_WIDTH) / 2); // 16 pixels
      const croppedBuffer = new Uint8Array(INPUT_WIDTH * INPUT_HEIGHT * 3);
      
      for (let y = 0; y < INPUT_HEIGHT; y++) {
        for (let x = 0; x < INPUT_WIDTH; x++) {
          const srcIdx = ((y + cropOffset) * 256 + (x + cropOffset)) * 3;
          const dstIdx = (y * INPUT_WIDTH + x) * 3;
          croppedBuffer[dstIdx] = resized[srcIdx];
          croppedBuffer[dstIdx + 1] = resized[srcIdx + 1];
          croppedBuffer[dstIdx + 2] = resized[srcIdx + 2];
        }
      }

      // Create tensor with proper dimensions
      const pixelCount = INPUT_WIDTH * INPUT_HEIGHT;
      const tensorData = new Float32Array(3 * pixelCount);

      // Convert from interleaved RGB to planar CHW format with ImageNet normalization
      for (let i = 0; i < pixelCount; i++) {
        // Sharp gives pixels in interleaved RGB format (R,G,B,R,G,B,...)
        const r = croppedBuffer[i * 3] / 255.0;
        const g = croppedBuffer[i * 3 + 1] / 255.0;
        const b = croppedBuffer[i * 3 + 2] / 255.0;

        // Apply ImageNet normalization: (pixel - mean) / std
        tensorData[i] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0]; // R channel
        tensorData[i + pixelCount] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1]; // G channel
        tensorData[i + 2 * pixelCount] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2]; // B channel
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
    // Only save data when model is not confident - these are the edge cases we need to improve
    if (confidenceScore >= CONFIDENCE_THRESHOLD) {
      console.log(
        `Skipping save for ${url} - confidence ${(confidenceScore * 100).toFixed(2)}% is above threshold`
      );
      return;
    }

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
        "INSERT INTO url_training_dataset (uuid, url, is_scam, confidence_score) VALUES ($1, $2, $3, $4)",
        [uuid, url, isScam, confidenceScore]
      );

      // Save to filesystem
      await fs.writeFile(path.join(screenshotDir, `${uuid}.png`), screenshot);
      await fs.writeFile(path.join(htmlDir, `${uuid}.html`), html);

      console.log(
        `Saved low-confidence classification data for ${url} (${isScam ? "scam" : "non_scam"}, confidence: ${(confidenceScore * 100).toFixed(2)}%)`
      );
    } catch (error) {
      console.error(`Error saving classification data for ${url}:`, error);
    } finally {
      client.release();
    }
  }
}

export const aiClassifierService = new AiClassifierService();
