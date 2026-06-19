var hrThreshold = 100;
var tremorSens = 5;
var isVibrating = false;
var vibrationInterval = null;
var currentBpm = null;
var lastValidBpm = null;
var tremorDetected = false;
var tremorLevel = 0;
var tremorStable = 0;
var ACCEL_WIN = 25;
var diffWindow = new Float32Array(ACCEL_WIN);
var windowIdx = 0;
var tremorTicks = 0;
var tickCount = 0;
var lastDraw = 0;

function startVibrating() {
  if (isVibrating) return;
  isVibrating = true;
  vibrationInterval = setInterval(function() {
    Bangle.buzz(400, 1);
  }, 450);
}

function stopVibrating() {
  if (!isVibrating) return;
  isVibrating = false;
  if (vibrationInterval) {
    clearInterval(vibrationInterval);
    vibrationInterval = null;
  }
}

function checkAlerts() {
  var hrAlert = (currentBpm !== null && currentBpm > hrThreshold);
  if (hrAlert || tremorDetected) {
    startVibrating();
  } else {
    stopVibrating();
  }
}

function getTremorParams() {
  var diffMin = 0.08 - (tremorSens - 1) * 0.006;
  var diffMax = 0.22;
  var countThresh = 22 - (tremorSens - 1) * 1;
  return {diffMin: diffMin, diffMax: diffMax, countThresh: countThresh};
}

function draw() {
  var now = getTime();
  if (now - lastDraw < 0.3 && !tremorDetected) return;
  lastDraw = now;

  var bpm = currentBpm !== null ? currentBpm.toString() : (lastValidBpm ? lastValidBpm.toString() : "---");
  var barH = 20;
  var W = g.getWidth();
  var H = g.getHeight();

  g.clear();

  if (tremorDetected) {
    g.setColor("#ff6600");
  } else {
    g.setColor("#222222");
  }
  g.fillRect(0, 0, W, barH);

  g.setColor("#ffffff");
  g.setFont("6x8", 1).setFontAlign(-1, -1);
  g.drawString("T:" + tremorSens + "/10  L:" + tremorLevel + "%", 4, 2);
  g.setFontAlign(1, -1);
  g.drawString(isVibrating ? "ALERT" : "OK", W - 4, 2);

  g.setColor(g.theme.fg);
  g.setFont("Vector", 50).setFontAlign(0, 0);
  g.drawString(bpm, W / 2, H / 2 - 30);

  g.setFont("6x8", 2).setFontAlign(0, 0);
  g.drawString("bpm", W / 2, H / 2 + 18);

  g.setFont("6x8", 1).setFontAlign(0, 0);
  g.drawString("HR limit: " + hrThreshold, W / 2, H / 2 + 42);

  var alertY = H / 2 + 60;
  if (tremorDetected) {
    g.setColor("#ff6600");
    g.setFont("6x8", 2).setFontAlign(0, 0);
    g.drawString("TREMOR", W / 2, alertY);
    alertY += 18;
  }
  if (currentBpm !== null && currentBpm > hrThreshold) {
    g.setColor("#ff0000");
    g.setFont("6x8", 2).setFontAlign(0, 0);
    g.drawString("HIGH BPM!", W / 2, alertY);
  }
}

Bangle.on('HRM', function(hrm) {
  if (hrm.bpm && hrm.confidence > 50) {
    lastValidBpm = hrm.bpm;
    currentBpm = hrm.bpm;
  }
  checkAlerts();
  draw();
});

Bangle.on('accel', function(acc) {
  var oldDiff = diffWindow[windowIdx];
  var newDiff = acc.diff;

  if (oldDiff > 0.02 && oldDiff < 0.22) tremorTicks--;
  if (newDiff > 0.02 && newDiff < 0.22) tremorTicks++;

  diffWindow[windowIdx] = newDiff;
  windowIdx = windowIdx + 1;
  if (windowIdx >= ACCEL_WIN) windowIdx = 0;

  tickCount = tickCount + 1;
  if (tickCount >= ACCEL_WIN) tickCount = ACCEL_WIN;

  if (tickCount >= ACCEL_WIN) {
    var p = getTremorParams();
    var isTremorNow = (tremorTicks >= p.countThresh);

    if (isTremorNow) {
      tremorStable = tremorStable + 1;
      if (tremorStable > 5) tremorStable = 5;
    } else {
      tremorStable = tremorStable - 1;
      if (tremorStable < 0) tremorStable = 0;
    }

    tremorDetected = (tremorStable >= 2);
    tremorLevel = Math.min(100, Math.round(tremorTicks * 100 / ACCEL_WIN));

    checkAlerts();
    draw();
  }
});

Bangle.on('touch', function(btn, e) {
  var barH = 20;
  if (e.y < barH + 8) {
    tremorSens = tremorSens + 1;
    if (tremorSens > 10) tremorSens = 1;
  } else if (e.y < g.getHeight() / 2 + 10) {
    if (hrThreshold < 180) hrThreshold += 5;
  } else {
    if (hrThreshold > 45) hrThreshold -= 5;
  }
  draw();
});

setWatch(function() {
  stopVibrating();
  Bangle.setHRMPower(0, 'ptsdnight');
  Bangle.setPollInterval(80);
  load();
}, BTN1, {repeat: false});

g.clear();
g.setFont("6x8", 2).setFontAlign(0, 0);
g.drawString("Starting...", g.getWidth() / 2, g.getHeight() / 2);

Bangle.accelWr(0x1B, 0x01 | 0x40);
Bangle.setPollInterval(40);
Bangle.setHRMPower(1, 'ptsdnight');
draw();

Bangle.loadWidgets();
Bangle.drawWidgets();
