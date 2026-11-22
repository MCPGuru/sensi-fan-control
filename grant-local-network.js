#!/usr/bin/env node
/*
 * Trigger the macOS "Local Network" permission prompt for THIS node binary.
 *
 * Why this exists: Homebridge runs under launchd (hb-service). A launchd daemon
 * has no GUI session, so macOS silently denies Local Network access and never
 * creates an entry in System Settings - which is why that list looks empty and
 * there is nothing to approve. The permission is keyed to the node binary path,
 * not to Homebridge, so granting it once here applies to the daemon too.
 *
 * RUN THIS FROM Terminal.app (a real GUI window), NOT over SSH and not from a
 * launchd job - otherwise there is no session to display the prompt in and you
 * get the same silent denial.
 *
 *   node grant-local-network.js
 *
 * Approve the dialog, then restart Homebridge:
 *   launchctl kickstart -k gui/$UID/com.homebridge.server
 *
 * Binds the mDNS multicast group (224.0.0.251:5353) briefly. It does not
 * advertise anything and does not touch Homebridge, so it is safe to run while
 * Homebridge is up - SO_REUSEADDR means it will not steal the port.
 */
const dgram = require('dgram');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

console.log(`node binary: ${process.execPath}`);
console.log('Binding mDNS multicast to trigger the Local Network prompt...\n');

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

sock.on('error', (err) => {
  console.error(`socket error: ${err.message}`);
  finish(false);
});

sock.bind(MDNS_PORT, () => {
  try {
    sock.addMembership(MDNS_ADDR);
  } catch (e) {
    console.error(`addMembership failed: ${e.message}`);
  }
  // Sending is what actually provokes the prompt on recent macOS.
  const query = Buffer.from([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x09, 0x5f, 0x73, 0x65, 0x72, 0x76, 0x69, 0x63, 0x65, 0x73,
    0x07, 0x5f, 0x64, 0x6e, 0x73, 0x2d, 0x73, 0x64,
    0x04, 0x5f, 0x75, 0x64, 0x70,
    0x05, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0x00,
    0x00, 0x0c, 0x00, 0x01,
  ]);
  sock.send(query, MDNS_PORT, MDNS_ADDR, (err) => {
    if (err) {
      console.error(`send failed: ${err.message}`);
    }
  });

  let replies = 0;
  sock.on('message', () => {
    replies += 1;
  });

  setTimeout(() => {
    console.log(replies > 0
      ? `Saw ${replies} mDNS replies - this binary CAN reach the local network.`
      : 'Saw NO mDNS replies - permission is most likely still denied.');
    finish(replies > 0);
  }, 4000);
});

function finish(ok) {
  try { sock.close(); } catch { /* already closed */ }
  console.log('\nIf a dialog appeared, click Allow. Then check:');
  console.log('  System Settings -> Privacy & Security -> Local Network');
  console.log('and confirm an entry now exists for node (or Terminal).\n');
  console.log('Then restart Homebridge:');
  console.log('  launchctl kickstart -k gui/$UID/com.homebridge.server');
  process.exit(ok ? 0 : 1);
}
