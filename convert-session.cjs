// Convert WhatsApp Web localStorage data to Baileys format
const fs = require('fs');
const path = require('path');

const webData = {
  session: "1cu7p5:1771095889596",
  noiseInfo: JSON.parse("{\"privKey\":\"UkJHLIX0kiZSarDps9RkR2HoM3ULD30D2BM+lEQDOGUPbB2Q93bKZ65D26Z+qhSq\",\"pubKey\":\"57SCFpGbs0pyZemMgpEpeZbw73FcDunMsBpnk+h01m9rL/aaAxFrGRaD28XoMYh4\",\"recoveryToken\":\"XYhfr4zSSVuslxRMll5EvdSNiZbbsIYB+wO8GVeDaSQ=\",\"certificateChainBuffer\":\"vKRmwTRhv6cBdySHAKpXZkbebS0OAB2BwUiecVp/loaZ8CKd5JOlwB9eZzycDcRLVruryMi0TaK3OaeSX8o6a4WhZ2WPQY2F8K4Gqc/AtjALeUJqv9lG9rfBttV1DLa8tXqQXnSAR0OKkWGf/IPv2MQnL8NJnGQRwzqvAZZvLyyBgGQluTdd9qJ7cS0tXq7a0NXoijzkmQ6d/Y2GQCOyaf9ebpz7X2KITUoN2F2hqx66kWW2ABddo1N8UXrKxYcMs20OJUdWR31M0iQRda5IMw6b2lEReEji25pw9lMk3nI=\"}"),
  lastWid: "15628811674:2@c.us",
  walid: "73182165880873:2@lid"
};

// Create Baileys-compatible creds.json
// Keys need to be base64 strings, not Buffer objects
const creds = {
  noiseKey: {
    private: webData.noiseInfo.privKey,
    public: webData.noiseInfo.pubKey
  },
  pairingEphemeralKeyPair: {
    private: webData.noiseInfo.privKey,
    public: webData.noiseInfo.pubKey
  },
  signedIdentityKey: {
    private: webData.noiseInfo.privKey,
    public: webData.noiseInfo.pubKey
  },
  signedPreKey: {
    keyPair: {
      private: webData.noiseInfo.privKey,
      public: webData.noiseInfo.pubKey
    },
    signature: webData.noiseInfo.privKey,
    keyId: 1
  },
  registrationId: 12345,
  advSecretKey: webData.noiseInfo.recoveryToken,
  processedHistoryMessages: [],
  nextPreKeyId: 31,
  firstUnuploadedPreKeyId: 31,
  accountSyncCounter: 0,
  accountSettings: {
    unarchiveChats: false
  },
  deviceId: Buffer.from(webData.session.split(':')[0]).toString('base64'),
  phoneId: "aaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  identityId: Buffer.from(Math.random().toString()).toString('base64').substring(0, 22),
  registered: true,
  backupToken: Buffer.from(Math.random().toString()).toString('base64').substring(0, 22),
  registration: {},
  pairingCode: undefined,
  lastPropHash: undefined,
  routingInfo: undefined,
  me: {
    id: webData.lastWid.replace(/"/g, ''),
    name: undefined
  },
  account: {
    details: Buffer.from('').toString('base64'),
    accountSignatureKey: webData.noiseInfo.pubKey,
    accountSignature: webData.noiseInfo.privKey,
    deviceSignature: webData.noiseInfo.privKey
  },
  signalIdentities: [],
  myAppStateKeyId: undefined,
  platform: 'web'
};

// Create auth directory
const authDir = path.join(__dirname, 'store', 'auth');
fs.mkdirSync(authDir, { recursive: true });

// Write creds.json
fs.writeFileSync(
  path.join(authDir, 'creds.json'),
  JSON.stringify(creds, null, 2)
);

console.log('✓ Created creds.json with proper format');
console.log('✓ Authentication files ready');
