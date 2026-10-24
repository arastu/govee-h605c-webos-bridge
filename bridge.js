// govee-bridge: HyperHDR "udpraw" LED frames -> Govee H605C over the TV's own Bluetooth (webOS bluetooth2 GATT API)
// Runs on webOS 4.x node v0.12 (ES5 only). Start with:
//   NODE_PATH=/usr/palm/nodejs:/usr/lib/node_modules node bridge.js
var palmbus = require('palmbus');
var dgram = require('dgram');
var fs = require('fs');

var CONFIG_PATH = process.argv[2] || '/media/developer/govee-bridge/config.json';
var cfg = {
  address: 'd7:37:32:32:36:62',        // Govee BLE address
  segments: 15,                        // segment count (2-byte mask -> max 16)
  udpPort: 19446,                      // HyperHDR udpraw target port (host 127.0.0.1)
  colorTolerance: 20,                  // max per-channel diff to merge segments into one write
  changeThreshold: 10,                 // skip a segment if it moved less than this since last send
  heartbeatMs: 2000,
  writeGapMs: 6,                       // minimum gap between consecutive BLE writes
  minFrameMs: 80,                      // do not start a new frame sooner than this (rate limit)
  reverse: false,                      // reverse segment order (set from config after visual test)
  offset: 0,                           // rotate segment order
  brightness: null,                    // 1..100 to force Govee brightness at start, null = leave as is
  powerOn: true,
  log: '/tmp/govee-bridge.log'
};
try { var fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); for (var k in fileCfg) cfg[k] = fileCfg[k]; } catch (e) {}

var SVC = '00010203-0405-0607-0809-0a0b0c0d1910';
var CHR = '00010203-0405-0607-0809-0a0b0c0d2b11';
var BT = 'luna://com.webos.service.bluetooth2/';

function log(s) {
  var line = new Date().toISOString() + ' ' + s + '\n';
  try { fs.appendFileSync(cfg.log, line); } catch (e) {}
  process.stdout.write(line);
}

function frame(bytes) {
  var b = bytes.slice(0);
  while (b.length < 19) b.push(0);
  var ck = 0;
  for (var i = 0; i < 19; i++) ck ^= b[i];
  b.push(ck);
  return b;
}
function cmdPower(on) { return frame([0x33, 0x01, on ? 1 : 0]); }
function cmdBrightness(p) { return frame([0x33, 0x04, p]); }
function cmdHeartbeat() { return frame([0xaa, 0x01]); }
function cmdColorMask(r, g, b, mask) {
  return frame([0x33, 0x05, 0x15, 0x01, r, g, b, 0, 0, 0, 0, 0, mask & 0xff, (mask >> 8) & 0xff]);
}

var handle = new palmbus.Handle('', false);
var appId = null;
var connected = false;
var connecting = false;
var busy = false;
var pendingFrame = null;
var lastSent = [];     // per segment [r,g,b] last written
var lastWriteAt = 0;
var lastFrameAt = 0;
var frameTimer = null;
var writeCount = 0, frameCount = 0, droppedFrames = 0;
var connReq = null;

function call(method, obj, cb) {
  var req = handle.call(BT + method, JSON.stringify(obj));
  var done = false;
  req.addListener('response', function (msg) {
    if (done) return; done = true;
    var p = {};
    try { p = JSON.parse(msg.payload()); } catch (e) {}
    cb(p);
  });
  req.addListener('cancel', function () { if (!done) { done = true; cb({ returnValue: false, errorText: 'cancelled' }); } });
}

function connect() {
  if (connecting) return;
  connecting = true; connected = false; appId = null;
  log('connecting to ' + cfg.address);
  if (connReq) { try { connReq.cancel(); } catch (e) {} connReq = null; }
  var first = true;
  connReq = handle.subscribe(BT + 'gatt/connect', JSON.stringify({ address: cfg.address, subscribe: true }));
  connReq.addListener('response', function (msg) {
    var p = {};
    try { p = JSON.parse(msg.payload()); } catch (e) {}
    if (first) {
      first = false;
      if (!p.returnValue) {
        log('connect failed: ' + JSON.stringify(p));
        connecting = false;
        setTimeout(connect, 3000);
        return;
      }
      appId = p.appId;
      log('connected, appId=' + appId + ', discovering services');
      call('gatt/discoverServices', { address: cfg.address }, function (r) {
        log('discoverServices: ' + JSON.stringify(r));
        setTimeout(function () {
          connected = true; connecting = false; lastSent = [];
          var init = [];
          if (cfg.powerOn) init.push(cmdPower(true));
          if (cfg.brightness) init.push(cmdBrightness(cfg.brightness));
          writeSeq(init, function () { log('ready'); kick(); });
        }, 1500);
      });
    } else {
      // later messages on the subscription signal state changes
      log('connect subscription update: ' + JSON.stringify(p).substring(0, 200));
      if (p.returnValue === false || p.connected === false || p.disconnected === true) {
        onDisconnected('subscription says disconnected');
      }
    }
  });
  connReq.addListener('cancel', function (msg) {
    log('connect subscription cancelled');
    onDisconnected('subscription cancelled');
  });
}

function onDisconnected(why) {
  if (!connected && !connecting) return;
  log('disconnected: ' + why);
  connected = false; connecting = false; busy = false; appId = null;
  if (connReq) { try { connReq.cancel(); } catch (e) {} connReq = null; }
  call('gatt/disconnect', { address: cfg.address }, function () {});
  setTimeout(connect, 2000);
}

function write(bytes, cb) {
  if (!connected || appId === null) { cb(false); return; }
  var t = Date.now();
  call('gatt/writeCharacteristicValue', {
    appId: appId, service: SVC, characteristic: CHR, writeType: 'noresponse', value: { bytes: bytes }
  }, function (r) {
    writeCount++;
    lastWriteAt = Date.now();
    if (!r.returnValue) {
      log('write failed: ' + JSON.stringify(r));
      if (r.errorCode === 136 || r.errorCode === 130) onDisconnected('write error ' + r.errorCode);
      cb(false);
    } else cb(true, Date.now() - t);
  });
}

function writeSeq(list, cb) {
  var i = 0;
  (function next() {
    if (i >= list.length) { cb(); return; }
    write(list[i++], function () {
      if (cfg.writeGapMs > 0) setTimeout(next, cfg.writeGapMs); else next();
    });
  })();
}

// ---- frame processing ----
function segOrder(i) {
  var n = cfg.segments;
  var j = (i + cfg.offset) % n;
  if (cfg.reverse) j = (n - 1 - j + n) % n;
  return j;
}

function planWrites(colors) {
  // colors: array of [r,g,b] per logical segment (index = hyperhdr LED index)
  var n = colors.length;
  var changed = [];
  for (var i = 0; i < n; i++) {
    var c = colors[i], l = lastSent[i];
    if (!l || Math.abs(c[0] - l[0]) >= cfg.changeThreshold || Math.abs(c[1] - l[1]) >= cfg.changeThreshold || Math.abs(c[2] - l[2]) >= cfg.changeThreshold) {
      changed.push(i);
    }
  }
  var groups = []; // {sum:[r,g,b], count, mask, members}
  for (var k = 0; k < changed.length; k++) {
    var idx = changed[k], col = colors[idx], placed = false;
    for (var g = 0; g < groups.length; g++) {
      var G = groups[g], avg = [G.sum[0] / G.count, G.sum[1] / G.count, G.sum[2] / G.count];
      if (Math.abs(avg[0] - col[0]) <= cfg.colorTolerance && Math.abs(avg[1] - col[1]) <= cfg.colorTolerance && Math.abs(avg[2] - col[2]) <= cfg.colorTolerance) {
        G.sum[0] += col[0]; G.sum[1] += col[1]; G.sum[2] += col[2]; G.count++;
        G.mask |= (1 << segOrder(idx)); G.members.push(idx); placed = true; break;
      }
    }
    if (!placed) groups.push({ sum: col.slice(0), count: 1, mask: 1 << segOrder(idx), members: [idx] });
  }
  var writes = [];
  for (var g2 = 0; g2 < groups.length; g2++) {
    var G2 = groups[g2];
    var r = Math.round(G2.sum[0] / G2.count), gg = Math.round(G2.sum[1] / G2.count), b = Math.round(G2.sum[2] / G2.count);
    writes.push(cmdColorMask(r, gg, b, G2.mask));
    for (var m = 0; m < G2.members.length; m++) lastSent[G2.members[m]] = [r, gg, b];
  }
  return writes;
}

function kick() {
  if (busy || !connected || !pendingFrame) return;
  var wait = cfg.minFrameMs - (Date.now() - lastFrameAt);
  if (wait > 0) {
    if (!frameTimer) frameTimer = setTimeout(function () { frameTimer = null; kick(); }, wait);
    return;
  }
  lastFrameAt = Date.now();
  var f = pendingFrame; pendingFrame = null;
  var writes = planWrites(f);
  if (!writes.length) { if (cfg.verbose) log('frame unchanged, no writes'); return; }
  busy = true;
  var t0 = Date.now();
  writeSeq(writes, function () {
    busy = false;
    frameCount++;
    if (frameCount <= 30 || cfg.verbose || frameCount % 200 === 0) log('frames=' + frameCount + ' writes=' + writeCount + ' dropped=' + droppedFrames + ' lastFrame=' + writes.length + ' writes in ' + (Date.now() - t0) + 'ms');
    kick();
  });
}

// ---- UDP input (HyperHDR udpraw: 3 bytes per LED, RGB) ----
var sock = dgram.createSocket('udp4');
sock.on('message', function (buf) {
  var n = Math.min(Math.floor(buf.length / 3), cfg.segments, 16);
  if (n <= 0) return;
  var colors = [];
  for (var i = 0; i < n; i++) colors.push([buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]]);
  if (pendingFrame) droppedFrames++;
  pendingFrame = colors;
  kick();
});
sock.on('error', function (e) { log('udp error ' + e); });
sock.bind(cfg.udpPort, '127.0.0.1', function () { log('listening udp 127.0.0.1:' + cfg.udpPort + ' segments=' + cfg.segments); });

// ---- heartbeat ----
setInterval(function () {
  if (connected && !busy && Date.now() - lastWriteAt > cfg.heartbeatMs) {
    write(cmdHeartbeat(), function () {});
  }
}, cfg.heartbeatMs);

process.on('uncaughtException', function (e) { log('uncaught: ' + (e && e.stack || e)); });
log('govee-bridge starting, cfg=' + JSON.stringify(cfg));
connect();
