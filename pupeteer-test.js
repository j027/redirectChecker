// puppeteer-extra is a drop-in replacement for puppeteer,
// it augments the installed puppeteer with plugin functionality
const puppeteer = require('puppeteer-extra')

// for better proxy managment
const proxyChain = require('proxy-chain');

const oldProxyUrl = "http://terriblename:C1qV9OqPHtNyaAqH_country-UnitedStates@proxy.packetstream.io:31112"


const newProxyUrl = await proxyChain.anonymizeProxy({ url: oldProxyUrl });

// add stealth plugin and use defaults (all evasion techniques)
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const {executablePath} = require('puppeteer')
puppeteer.use(StealthPlugin())

// puppeteer usage as normal
puppeteer.launch({ headless: false,  executablePath: executablePath(), 
  args: [`--proxy-server=${newProxyUrl}`] }).then(async browser => {

  console.log('Popup detection test')
  const page = await browser.newPage()

  page.setDefaultNavigationTimeout(0); // disable navigation timeout


  // keep track of redirect path
  const redirects = [];
  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  client.on('Network.requestWillBeSent', (e) => {
      if (e.type !== "Document") {
          return;
      }
      redirects.push(e.documentURL);
  });

  // block unnecessary things from loading
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if(["image", "font", "stylesheet", "media"].includes(req.resourceType())){
        req.abort();
    }
    else {
        req.continue();
    }
  })
  await page.goto('https://lovemeshy.com/ep/?lpley=eyJ0aW1lc3RhbXAiOiIxNjczMjg1MTQ2IiwiaGFzaCI6ImYzMGJhNDVjMzc0MTllNGI0YmU1NmVkYTJkN2MzM2RmZjUwMDQ1NzgifQ%3D%3D&bemobdata=c%3D3dbb53c4-e390-4811-884f-d74eb5ed50bc..l%3Da5e3f528-085c-48fe-bef5-39d69407d162..a%3D0..b%3D0..z%3D0.2..e%3D4fPOQyf6CG4..c1%3D59437..c2%3D838266..c3%3Dupdaterlife.com..c5%3Ddownload%2520install..c6%3DT-Mobile%2520USA..c7%3Dtx..c8%3D5379171..c9%3D172.56.88.128..r%3Dhttps%253A%252F%252Fupdaterlife.com%252F&cid=McDDXW3cjR87qPJghsc5H3')

  await page.waitForTimeout(10000)

  let pageTitle = await page.title()
  console.log(pageTitle)
  if (pageTitle.toLowerCase().includes("security center")) {
    console.log("Popup detected")
  }

  await browser.close()
  console.log(`All done`)
  await proxyChain.closeAnonymizedProxy(newProxyUrl, true);
})