import * as onnx from 'onnxruntime-node';
import { promises as fs } from 'fs';
import { Browser, chromium } from 'patchright';
import path from 'path';
import pool from "../dbPool.js";
import { spoofWindowsChrome, blockGoogleAnalytics, parseProxy } from "../utils/playwrightUtilities.js";
import crypto from 'crypto';
import sharp from 'sharp';

// Constants for the model
const INPUT_WIDTH = 1080;
const INPUT_HEIGHT = 1080;
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
      console.log('AI Classifier browser launched successfully');
      
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
      console.log('AI Classifier browser closed');
    }
  }
  
  async classifyUrl(url: string, isHunterProxy = false): Promise<ClassificationResult | null> {
    if (!this.browser || !this.model) {
      console.error('Browser or model not initialized');
      return null;
    }
    
    // Setup page and navigation
    const context = await this.browser.newContext({
      proxy: await parseProxy(isHunterProxy),
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
      // Preprocess the image
      const preprocessedImage = await this.preprocessImage(imageBuffer);
      
      // Create input tensor
      const inputTensor = new onnx.Tensor('float32', preprocessedImage, [1, 3, INPUT_HEIGHT, INPUT_WIDTH]);
      
      // Run inference
      const feeds = { 'images': inputTensor };
      const results = await this.model!.run(feeds);
      
      // Process output tensor
      const output = results['output'].data as Float32Array;
      
      // Extract predictions - assuming binary classification (non_scam, scam)
      const [nonScamConf, scamConf] = output;
      
      // Get max confidence and predicted class
      const confidenceScore = Math.max(nonScamConf, scamConf);
      const isScam = scamConf > nonScamConf;
      
      return { isScam, confidenceScore };
    } catch (error) {
      console.error('Error during model inference:', error);
      // Return a fallback prediction
      return { isScam: false, confidenceScore: 0 };
    }
  }
  
  private async preprocessImage(imageBuffer: Buffer): Promise<Float32Array> {
    // Resize and normalize the image using sharp
    const processedBuffer = await sharp(imageBuffer)
      .resize(INPUT_WIDTH, INPUT_HEIGHT)
      .removeAlpha()
      .raw()
      .toBuffer();
    
    // Convert to float32 and normalize
    const tensorData = new Float32Array(processedBuffer.length);
    
    // RGB channel order for ONNX models
    const channelSize = INPUT_WIDTH * INPUT_HEIGHT;
    const redChannel = new Uint8Array(processedBuffer.buffer, 0, channelSize);
    const greenChannel = new Uint8Array(processedBuffer.buffer, channelSize, channelSize);
    const blueChannel = new Uint8Array(processedBuffer.buffer, 2 * channelSize, channelSize);
    
    // Normalize each pixel value
    for (let i = 0; i < channelSize; i++) {
      // ONNX models typically expect CHW format (channels, height, width)
      tensorData[i] = redChannel[i] / 255.0;
      tensorData[i + channelSize] = greenChannel[i] / 255.0;
      tensorData[i + 2 * channelSize] = blueChannel[i] / 255.0;
    }
    
    return tensorData;
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