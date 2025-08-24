# RedirectChecker - Tech Support Scam Hunter

A sophisticated automated system designed to hunt and track tech support scams by following malicious advertising redirects across the web. This project monitors scam campaigns, tracks their takedown status across major security platforms, and uses AI-powered classification to identify fraudulent websites.

## ⚠️ Content Warning

**This software will access and load NSFW (Not Safe for Work) content during operation.**

RedirectChecker monitors advertisements on adult entertainment platforms including pornographic websites as part of its scam hunting methodology. When running this software:

- **Adult content will be loaded and displayed** in browser instances
- **Screenshots of NSFW sites may be captured** for AI analysis
- **Adult advertisements will be followed** as part of the tracking process
- **Explicit content may appear in logs and debugging output**

**Users should be aware that:**
- This software is not suitable for use in workplace environments
- Adult content exposure is an inherent part of the scam hunting process
- Users must be of legal age in their jurisdiction to view such content
- Appropriate content filtering may be necessary in shared environments

By using this software, you acknowledge that you understand and accept exposure to adult content as part of the scam detection process.

## 🎯 Overview

RedirectChecker combats tech support scams by:

- **Following malicious ads** from various sources (search engines, adult sites, etc.)
- **Tracking redirect chains** using multiple bypass strategies
- **AI-powered scam detection** via screenshot analysis
- **Monitoring takedown status** across security platforms
- **Automated reporting** to security services
- **Discord bot interface** for management and alerts

## 🏗️ Architecture

### Core Components

- **Discord Bot**: Management interface with slash commands
- **Hunter Services**: Automated ad crawling and redirect discovery
- **AI Classifier**: ONNX-based image classification for scam detection
- **Takedown Monitor**: Tracks removal status across security platforms
- **Browser Services**: Stealth browsing with anti-detection measures

### Database Schema

PostgreSQL database tracking:
- Redirect sources and destinations
- Takedown status across platforms
- AI classification results
- Browser user agents and proxies

## 🚀 Features

### Ad Hunting
- **Search Ad Hunter**: Monitors search engine advertisements
- **AdSpyGlass Hunter**: Tracks ads on adult entertainment sites
- **Pornhub Ad Hunter**: Specialized tracking for Pornhub advertisements
- **Typosquat Hunter**: Detects scams from typosquatted domains
> Typosquatted domains have ads that redirect somewhere, and sometimes they go to scams.

### Redirect Handling
Multiple redirect bypass strategies:
- HTTP redirect following
- JavaScript-based redirects (Weebly/DigitalOcean)
- Browser-based redirect simulation
- Specialized handlers for different platforms

### Stealth Technologies
- **Patchright**: Modified Playwright for enhanced stealth
- **Puppeteer-Extra-Stealth**: Some anti-detection measures were taken from here and ported to Playwright
- **Custom fingerprinting protection**
- **Proxy rotation and management**

### AI-Powered Classification
- ONNX-based image classification model
- Screenshot analysis for scam detection
- Training data management and storage
- Confidence-based classification thresholds

### Takedown Tracking
Monitors removal status across:
- **Google SafeBrowsing**
- **Microsoft SmartScreen** 
- **Netcraft**
- **DNS resolution status**

## 🛠️ Technology Stack

- **Runtime**: Node.js with TypeScript
- **Database**: PostgreSQL
- **Browser Automation**: Patchright (Playwright fork)
- **AI/ML**: ONNX Runtime
- **Bot Framework**: Discord.js
- **Image Processing**: Sharp
- **HTTP Client**: Undici with proxy support
- **Testing**: Vitest

## 📋 Prerequisites

- Node.js 22 with Yarn package manager
- PostgreSQL database
- Discord bot token and application
- Proxy services for stealth browsing
- API keys for various security services
- Mobile proxy with unlimited data for the hunter proxy
- Residential proxy that rotates ip on every request for the main proxy

## 🔧 Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/j027/redirectChecker.git
   cd redirectChecker
   ```

2. **Install dependencies**
   ```bash
   yarn install
   ```

3. **Configure environment**
   
   You must create a config.json file that follows the structure as defined in the code. See the Configuration section below for more details.

4. **Initialize database**
   ```bash
   yarn init-db:dev
   ```

5. **Deploy Discord commands**
   ```bash
   yarn deploy:dev
   ```

## ⚙️ Configuration

Create a `config.json` file with the following structure that meets the structure expected by `src/config.ts` which is what reads the config.json.

Environment variables are used in `.env` for Postgres credentials and credentials for the web risk API. If you do not have all the credentials, you may need to comment out those parts of  the code to prevent issues.

## 🚀 Usage

### Development Mode
```bash
yarn start:dev
```

### Production Mode
```bash
yarn build
yarn start
```

### Discord Commands

- `/add <url> <redirect_type>` - Add a new redirect to monitor
- `/remove <id>` - Remove a redirect from monitoring
- `/status` - View system status and statistics
- `/takedown_status <count>` - View recent takedowns and how long they took (default to last 10, but up to 20)

### Running Tests
```bash
yarn test
```
> Some of these tests require a valid display for the browser to open in as it's not always a headless browser.

## 🔍 Hunter Services

### Search Ad Hunter
Monitors search engine advertisements for tech support scam keywords and follows redirect chains.

### AdSpyGlass Hunter
Tracks advertisements on adult entertainment platforms where scam ads are commonly placed.

### Typosquat Hunter
Identifies typosquatted domains that redirect to scam sites.

## 🤖 AI Classification

The system uses an ONNX-based image classification model to analyze screenshots and determine if a website is a scam. The model processes 1280x1280 pixel screenshots with a confidence threshold of 0.7. This was created using Ultralytics YOLO, but I'll switch to something else because of the issues I had, it's probably the wrong tool for the job.

### Current Limitations
- **Model accuracy needs improvement**: The current AI model has known accuracy issues that are being addressed
- **False positive/negative rates**: Classifications may not always be accurate
- **Training data quality**: Ongoing work to improve training dataset

## 📊 Monitoring & Alerts

The system provides real-time monitoring through:
- Discord notifications for new scam discoveries
- Takedown status tracking across multiple platforms
- Performance metrics and health checks
- Automated reporting to security services

## 🗺️ Roadmap

### Planned Improvements
- **Enhanced AI model**: Fix current accuracy issues with the classification model
- **Additional ad providers**: Expand monitoring to more advertising networks
- **Improved stealth capabilities**: Enhanced anti-detection measures

### Potential Ad Providers
- Social media advertising platforms
- Mobile app advertisement networks
- Email-based advertising campaigns
- Additional adult content platforms

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## 📄 License

This project is licensed under the terms specified in the LICENSE file.

## ⚠️ Disclaimer

This tool is designed for research and cybersecurity purposes to help identify and combat online scams. Users should comply with all applicable laws and regulations when using this software. The authors are not responsible for any misuse of this tool.

Some of the flagging checks use undocumented APIs as there were no documented APIs that were able to check these security services. 

## 🔒 Security

- All credentials should be stored securely in the config file
- Use appropriate proxy services to maintain functionality
- Regularly rotate API keys and credentials
- Monitor for any potential security vulnerabilities

## 📞 Support

For questions, issues, or contributions, please open an issue on the GitHub repository.