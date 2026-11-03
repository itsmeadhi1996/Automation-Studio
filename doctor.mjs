import { launchBrowser } from './browsers.mjs';
import { OpenVpnConnect } from './vpn.mjs';

const DEFAULT_PORT = 3300;
const port = process.env.PORT || DEFAULT_PORT;

console.log(`Node ${process.version}; workspace ${process.cwd()}`);

for (const name of ['chrome', 'edge', 'firefox']) {
  let browser;
  try {
    browser = await launchBrowser(name);
    console.log(`${name}: ready`);
  } catch (error) {
    console.log(`${name}: ${error.message}`);
  } finally {
    await browser?.close();
  }
}

console.log('OpenVPN:', JSON.stringify(await new OpenVpnConnect().status()));
console.log(`Start Studio with npm start and open http://127.0.0.1:${port}. Use Check readiness before running a test.`);
