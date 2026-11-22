#!/usr/bin/env node
/*
 * Sensi setup helper.
 *
 *   node sensi-setup.js --login              log in with your Sensi email/password
 *                                            (needs SENSI_ANDROID_CLIENT_SECRET, see README)
 *   node sensi-setup.js --token <token>      use a refresh token captured from the Sensi app
 *   node sensi-setup.js --check              re-validate the token already in config.json
 *
 * On success the (rotated) refresh token is written into ~/.homebridge/config.json
 * and Homebridge is restarted.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { execSync } = require('child_process');

const CONFIG = path.join(os.homedir(), '.homebridge', 'config.json');
const TOKEN_STORE = path.join(os.homedir(), '.homebridge', 'sensi-fan-token.json');
const PLATFORM = 'SensiFanPlatform';

const FLEET = {
  url: 'https://oauth.sensiapi.io/token',
  id: 'fleet',
  secret: 'JLFjJmketRhj>M9uoDhusYKyi?zUyNqhGB)H2XiwLEF#KcGKrRD2JZsDQ7ufNven',
};
// The password sign-in uses the Sensi Android app's own OAuth client. Its secret is not
// shipped here. To use --login, supply it yourself (it can be read from the app's traffic
// or package):  SENSI_ANDROID_CLIENT_SECRET=... node sensi-setup.js --login
// Without it, use --token with a refresh token captured from the app (see README).
const ANDROID = {
  id: 'android',
  secret: process.env.SENSI_ANDROID_CLIENT_SECRET || '',
};

async function post(url, body, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      Accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      ...extraHeaders,
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, json, text };
}

/*
 * A single readline interface is shared by every prompt. Closing an interface
 * ends the underlying stdin stream, so creating a second one for the password
 * would see EOF immediately and never fire its callback.
 */
let rl = null;
function prompter() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  }
  return rl;
}

function closePrompter() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

/*
 * With piped stdin, readline can emit every buffered line before the second
 * question is registered, silently dropping answers. Read the whole stream once
 * up front and serve answers from a queue instead.
 */
let pipedLines = null;
async function readPipedLines() {
  if (pipedLines === null) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  }
  return pipedLines;
}

async function ask(question) {
  if (!process.stdin.isTTY) {
    const lines = await readPipedLines();
    const answer = (lines.shift() || '').trim();
    process.stdout.write(question + '\n');
    return answer;
  }
  return new Promise((resolve) => {
    prompter().question(question, (answer) => resolve(answer.trim()));
  });
}

function askHidden(question) {
  // Echo suppression only works on a real terminal; with piped stdin there is
  // nothing being echoed to hide.
  if (!process.stdin.isTTY) {
    return ask(question);
  }
  return new Promise((resolve) => {
    const iface = prompter();
    let shown = false;
    const original = iface._writeToOutput.bind(iface);
    iface._writeToOutput = () => {
      if (!shown) {
        iface.output.write(question);
        shown = true;
      }
    };
    iface.question(question, (answer) => {
      iface._writeToOutput = original;
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function exchangeRefreshToken(refreshToken) {
  const r = await post(FLEET.url, {
    client_id: FLEET.id,
    client_secret: FLEET.secret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (r.status !== 200 || !r.json || !r.json.access_token) {
    throw new Error(`Token exchange failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  }
  return r.json;
}

async function passwordLogin(username, password) {
  const deviceId = crypto.randomUUID();
  const r = await post(
    `https://oauth.sensiapi.io/token?device=${deviceId}`,
    {
      username,
      password,
      client_id: ANDROID.id,
      client_secret: ANDROID.secret,
      grant_type: 'password',
    },
    { 'x-platform': 'android' }
  );
  if (r.status !== 200 || !r.json || !r.json.refresh_token) {
    throw new Error(`Login failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  }
  return r.json;
}

function saveToken(refreshToken) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const block = (cfg.platforms || []).find((p) => p.platform === PLATFORM);
  if (!block) {
    throw new Error(`No ${PLATFORM} block found in ${CONFIG}`);
  }
  block.refreshToken = refreshToken;
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 4) + '\n');
  // Drop any previously rotated token so the plugin reseeds from this one.
  try {
    fs.unlinkSync(TOKEN_STORE);
  } catch {
    /* nothing stored */
  }
  console.log(`Saved refresh token to ${CONFIG}`);
}

function restartHomebridge() {
  try {
    const pid = execSync('pgrep -f "^homebridge$" | head -1').toString().trim();
    if (pid) {
      execSync(`kill -TERM ${pid}`);
      console.log(`Restarting Homebridge (was PID ${pid}); hb-service will respawn it.`);
    } else {
      console.log('Homebridge process not found - restart it yourself.');
    }
  } catch {
    console.log('Could not restart Homebridge automatically - restart it from the UI.');
  }
}

function configuredSeed() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const block = (cfg.platforms || []).find((p) => p.platform === PLATFORM);
  return (block && block.refreshToken) || '';
}

function configuredToken() {
  const seed = configuredSeed();
  try {
    const stored = JSON.parse(fs.readFileSync(TOKEN_STORE, 'utf8'));
    if (stored.seedToken === seed && stored.currentToken) {
      return stored.currentToken;
    }
  } catch {
    /* no stored token */
  }
  return seed;
}

/*
 * Every exchange rotates the refresh token, so --check cannot simply throw the
 * result away: doing so would leave the plugin holding a token the server has
 * already superseded. Write the rotated token back to the store the plugin
 * reads on startup.
 */
function storeRotatedToken(refreshToken) {
  try {
    fs.writeFileSync(
      TOKEN_STORE,
      JSON.stringify({ seedToken: configuredSeed(), currentToken: refreshToken }),
      { mode: 0o600 }
    );
    console.log(`Rotated refresh token written to ${TOKEN_STORE}`);
  } catch (e) {
    console.warn(`Warning: could not persist rotated token: ${e.message}`);
  }
}

(async () => {
  const args = process.argv.slice(2);
  const mode = args[0];
  let tokens;

  try {
    if (mode === '--login') {
      if (!ANDROID.secret) {
        throw new Error('--login needs SENSI_ANDROID_CLIENT_SECRET set (see README). Or use --token.');
      }
      const user = await ask('Sensi email: ');
      const pass = await askHidden('Sensi password: ');
      console.log('Logging in...');
      tokens = await passwordLogin(user, pass);
    } else if (mode === '--token') {
      const token = args[1] || (await ask('Paste Sensi refresh token: '));
      console.log('Validating token...');
      tokens = await exchangeRefreshToken(token);
    } else if (mode === '--check') {
      const token = configuredToken();
      if (!token) {
        throw new Error('No refresh token configured yet.');
      }
      console.log('Validating configured token...');
      tokens = await exchangeRefreshToken(token);
      console.log('Token is valid.');
      storeRotatedToken(tokens.refresh_token);
      console.log('Restart Homebridge so it picks up the rotated token.');
    } else {
      console.log('Usage: node sensi-setup.js [--login | --token <refresh_token> | --check]');
      process.exit(1);
    }
    closePrompter();
  } catch (e) {
    closePrompter();
    console.error(`\nFAILED: ${e.message}`);
    if (mode === '--login') {
      console.error('\nThe password grant may be blocked by Emerson. Fall back to capturing');
      console.error('the token from the free Sensi mobile app with mitmproxy:');
      console.error('  1. mitmproxy -w /tmp/sensi.flows   (then trust the mitm CA on the phone)');
      console.error('  2. Point the phone at this machine as its HTTP proxy');
      console.error('  3. Force-quit and reopen the Sensi app so it re-authenticates');
      console.error('  4. Find the POST to oauth.sensiapi.io/token and copy refresh_token');
      console.error('  5. node sensi-setup.js --token <that token>');
      console.error('\nThe manager.sensicomfort.com web portal also works but is a paid product.');
    }
    process.exit(1);
  }

  console.log(`Success. Access token expires in ${tokens.expires_in || '?'}s.`);
  if (mode !== '--check') {
    saveToken(tokens.refresh_token);
    restartHomebridge();
  }
})();
