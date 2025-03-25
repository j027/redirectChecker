import * as onnx from 'onnxruntime-node';
import { promises as fs } from 'fs';
import { Browser, chromium } from 'patchright';
import path from 'path';
import pool from "../dbPool.js";
import { spoofWindowsChrome, blockGoogleAnalytics, parseProxy } from "../utils/playwrightUtilities.js";
import crypto from 'crypto';
import sharp from 'sharp';

// Constants for the model
const INPUT_WIDTH = 1280;
const INPUT_HEIGHT = 1280;
const CONFIDENCE_THRESHOLD = 0.7;

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
  
  async init() {
    try {
      // Launch our own browser instance
      this.browser = await chromium.launch({
        headless: false,
        executablePath: "/snap/bin/chromium",
        chromiumSandbox: true,
      });
      
      // Load the ONNX model
      const modelPath = path.join(process.cwd(), 'models', 'image_scam_detector.onnx');
      this.model = await onnx.InferenceSession.create(modelPath);
      console.log('AI Classifier model loaded successfully');
    } catch (error) {
      console.error('Error initializing AI Classifier:', error);
      throw error;
    }
  }
  
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
  
  async classifyUrl(url: string): Promise<ClassificationResult | null> {
    if (!this.browser || !this.model) {
      console.error('Browser or model not initialized');
      return null;
    }
    
    // Setup page and navigation
    const context = await this.browser.newContext({
      proxy: await parseProxy(true),
      viewport: null,
    });
    const page = await context.newPage();
    await spoofWindowsChrome(context, page);
    await blockGoogleAnalytics(page);
    
    try {
      // Navigate to URL and capture data
      await page.goto(url);
      
      // Click on the top left to activate potential popups
      await page.mouse.click(0, 0);
      
      // Capture screenshot and HTML
      const screenshot = await page.screenshot();
      const html = await page.content();
      const currentUrl = page.url(); // Get the final URL after any redirects
      
      // Process the image for the model
      const prediction = await this.runInference(screenshot);
      const isScam = prediction.isScam;
      const confidenceScore = prediction.confidenceScore;
      
      // Save data regardless of classification
      await this.saveData(currentUrl, screenshot, html, isScam, confidenceScore);
      
      // Log prediction details
      const confidencePercent = (confidenceScore * 100).toFixed(2);
      if (confidenceScore >= CONFIDENCE_THRESHOLD) {
        console.log(`✅ Confident Prediction for ${currentUrl}: ${isScam ? 'SCAM' : 'NON_SCAM'} | Confidence: ${confidencePercent}%`);
      } else {
        console.log(`⚠️ Low Confidence Prediction for ${currentUrl}: ${isScam ? 'SCAM' : 'NON_SCAM'} | Confidence: ${confidencePercent}%`);
      }
      
      return {
        isScam,
        confidenceScore,
        screenshot,
        html,
        url: currentUrl
      };
    } catch (error) {
      console.error(`Error classifying URL ${url}:`, error);
      return null;
    } finally {
      await page.close();
      await context.close();
    }
  }
  
  private async runInference(imageBuffer: Buffer): Promise<{isScam: boolean; confidenceScore: number}> {
    try {
      // Log start of inference
      console.log('Starting inference for image');
      
      // Preprocess the image
      const preprocessedImage = await this.preprocessImage(imageBuffer);
      
      // Create input tensor with correct dimensions
      const inputTensor = new onnx.Tensor('float32', preprocessedImage, [1, 3, INPUT_HEIGHT, INPUT_WIDTH]);
      
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
      console.log('Raw output:', Array.from(output));
      
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
      
      console.log(`Prediction: class=${maxConfidenceIdx} (${isScam ? 'scam' : 'non_scam'}), confidence=${confidenceScore}`);
      
      return { isScam, confidenceScore };
    } catch (error) {
      console.error('Error during model inference:', error);
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
        const r = processedBuffer[i * 3] / 255.0;     // R value
        const g = processedBuffer[i * 3 + 1] / 255.0; // G value
        const b = processedBuffer[i * 3 + 2] / 255.0; // B value
        
        // Store in CHW format (all R values, then all G values, then all B values)
        tensorData[i] = r;                     // R channel
        tensorData[i + pixelCount] = g;        // G channel
        tensorData[i + 2 * pixelCount] = b;    // B channel
      }
      
      return tensorData;
    } catch (error) {
      console.error('Error in preprocessImage:', error);
      throw error;
    }
  }
  
  private async saveData(
    url: string, 
    screenshot: Buffer, 
    html: string, 
    isScam: boolean, 
    confidenceScore: number
  ): Promise<void> {
    const uuid = crypto.randomUUID();
    const client = await pool.connect();
    
    try {
      // Ensure directories exist
      const screenshotDir = path.join(process.cwd(), 'data', 'screenshots', isScam ? 'scam' : 'non_scam');
      const htmlDir = path.join(process.cwd(), 'data', 'html', isScam ? 'scam' : 'non_scam');
      
      await fs.mkdir(screenshotDir, { recursive: true });
      await fs.mkdir(htmlDir, { recursive: true });
      
      // Save to filesystem
      await fs.writeFile(path.join(screenshotDir, `${uuid}.png`), screenshot);
      await fs.writeFile(path.join(htmlDir, `${uuid}.html`), html);
      
      // Save to database
      await client.query(
        "INSERT INTO url_training_dataset (uuid, url, is_scam, confidence_score) VALUES ($1, $2, $3, $4)",
        [uuid, url, isScam, confidenceScore]
      );
      
      console.log(`Saved classification data for ${url} (${isScam ? 'scam' : 'non_scam'}, confidence: ${confidenceScore.toFixed(4)})`);
    } catch (error) {
      console.error(`Error saving classification data for ${url}:`, error);
    } finally {
      client.release();
    }
  }
}

export const aiClassifierService = new AiClassifierService();