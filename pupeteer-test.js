// puppeteer-extra is a drop-in replacement for puppeteer,
// it augments the installed puppeteer with plugin functionality
const puppeteer = require('puppeteer-extra')

// for better proxy management
const proxyChain = require('proxy-chain');

const oldProxyUrl = "http://terriblename:C1qV9OqPHtNyaAqH_country-UnitedStates@proxy.packetstream.io:31112"


// add stealth plugin and use defaults (all evasion techniques)
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const {executablePath} = require('puppeteer')
puppeteer.use(StealthPlugin());

// puppeteer usage as normal
(async() =>{
  const newProxyUrl = await proxyChain.anonymizeProxy({ url: oldProxyUrl });

  const browser = await puppeteer.launch({ headless: false,
    executablePath: executablePath(),
    args: [`--proxy-server=${newProxyUrl}`] })

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
  await page.goto("https://bit.ly/3CF6AFv")

  await page.waitForTimeout(10000)

  console.log(`Redirect Path: ${redirects.join(" --> ")}`)

  let pageTitle = await page.title()
  console.log(pageTitle)
  if (pageTitle.toLowerCase().includes("security center")) {
    console.log("Popup detected")
  }
  await browser.close()
  console.log(`All done`)
  await proxyChain.closeAnonymizedProxy(newProxyUrl, true);
})();