var hrMax = 140;
var spikeThresh = 10;
var tremorSens = 1;
var isVibrating = false;
var vibrationInterval = null;
var currentBpm = null;
var lastValidBpm = null;
var bpmStableCount = 0;
var bpmLastValue = 0;
var bpmHistory = [];
var spikeDelta = 0;
var lastConf = 0;
var tremorDetected = false;
var tremorLevel = 0;
var tremorStable = 0;
var ACCEL_WIN = 25;
var diffWindow = new Float32Array(ACCEL_WIN);
var windowIdx = 0;
var tremorTicks = 0;
var tickCount = 0;
var lastDraw = 0;
var lastBpmTime = 0;
var calmStart = 0;
var RECOVERY = 15;

var BLE_SVC = "a19585e9-0001-49d0-015f-b3e2b9a0c854";
var BLE_CHAR_LOG = "a19585e9-0002-49d0-015f-b3e2b9a0c854";
var BLE_CHAR_STATUS = "a19585e9-0003-49d0-015f-b3e2b9a0c854";
var BLE_CHAR_CSV = "a19585e9-0004-49d0-015f-b3e2b9a0c854";

var LOG_MAX = 600;
var logEntries = [];
var logFileIdx = 0;
var lastLogFlush = 0;
var LOG_FLUSH_INTERVAL = 30;
var lastBleNotify = 0;
var BLE_NOTIFY_MIN = 2;
var bleValue = "";
var csvValue = "";
var statusValue = "{}";

function initBLE() {
  try {
    NRF.setServices({
    }, {uart: false});
    NRF.setServices({
      BLE_SVC: {
        BLE_CHAR_LOG: {
          value: "",
          maxLen: 220,
          readable: true,
          notify: true,
          description: "PTSD Log"
        },
        BLE_CHAR_STATUS: {
          value: "{}",
          maxLen: 80,
          readable: true,
          notify: true,
          description: "PTSD Status"
        },
        BLE_CHAR_CSV: {
          value: "",
          maxLen: 220,
          readable: true,
          description: "PTSD CSV"
        }
      }
    });
  } catch(e) {}
}

function logEvent(type, data) {
  var entry = {i: logFileIdx++, t: getTime(), type: type};
  for (var k in data) entry[k] = data[k];
  logEntries.push(entry);
  while (logEntries.length > LOG_MAX) logEntries.shift();

  if (getTime() - lastBleNotify >= BLE_NOTIFY_MIN) {
    flushBLE();
  }

  if (getTime() - lastLogFlush >= LOG_FLUSH_INTERVAL) {
    flushLogFile();
  }
}

function flushBLE() {
  lastBleNotify = getTime();
  try {
    bleValue = "";
    var start = Math.max(0, logEntries.length - 12);
    for (var i = start; i < logEntries.length; i++) {
      if (bleValue.length > 0) bleValue += "\n";
      bleValue += JSON.stringify(logEntries[i]);
    }
    if (bleValue.length > 220) {
      bleValue = bleValue.substring(bleValue.length - 220);
      var nl = bleValue.indexOf("\n");
      if (nl >= 0) bleValue = bleValue.substring(nl + 1);
    }

    statusValue = JSON.stringify({
      bpm: currentBpm,
      conf: lastConf,
      trm: tremorDetected ? 1 : 0,
      trmLvl: tremorLevel,
      trmTicks: tremorTicks,
      spike: spikeDelta,
      alert: isVibrating ? 1 : 0,
      entries: logEntries.length
    });

    NRF.updateServices({
      BLE_SVC: {
        BLE_CHAR_LOG: {
          value: bleValue,
          notify: true
        },
        BLE_CHAR_STATUS: {
          value: statusValue,
          notify: true
        }
      }
    });
  } catch(e) {}
}

function buildCSV() {
  var csv = "idx,time,type,bpm,conf,spike,trmDet,trmLvl,trmTicks,alert\n";
  for (var i = 0; i < logEntries.length; i++) {
    var e = logEntries[i];
    csv += [
      e.i,
      e.t,
      e.type,
      e.bpm || "",
      e.conf || "",
      e.spike || "",
      e.trmDet !== undefined ? (e.trmDet ? 1 : 0) : "",
      e.trmLvl !== undefined ? e.trmLvl : "",
      e.trmTicks !== undefined ? e.trmTicks : "",
      e.alert !== undefined ? (e.alert ? 1 : 0) : ""
    ].join(",") + "\n";
  }
  return csv;
}

function flushLogFile() {
  lastLogFlush = getTime();
  csvValue = buildCSV();
  try {
    require("Storage").write("ptsdnight.log", csvValue);
    NRF.updateServices({
      BLE_SVC: {
        BLE_CHAR_CSV: {
          value: csvValue.length > 220 ? csvValue.substring(0, 220) + "..." : csvValue
        }
      }
    });
  } catch(e) {}
}

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

function checkBpmSpike() {
  var now = getTime();
  while (bpmHistory.length > 0 && now - bpmHistory[0].time > 45) {
    bpmHistory.shift();
  }

  if (bpmHistory.length < 4) {
    spikeDelta = 0;
    return false;
  }

  var recentSum = 0, recentCount = 0;
  var baseSum = 0, baseCount = 0;

  for (var i = bpmHistory.length - 1; i >= 0; i--) {
    var age = now - bpmHistory[i].time;
    if (age <= 10) {
      recentSum += bpmHistory[i].bpm;
      recentCount++;
    } else {
      baseSum += bpmHistory[i].bpm;
      baseCount++;
    }
  }

  if (recentCount < 1 || baseCount < 1) {
    spikeDelta = 0;
    return false;
  }

  var recentAvg = recentSum / recentCount;
  var baseAvg = baseSum / baseCount;
  spikeDelta = Math.round(recentAvg - baseAvg);

  return (spikeDelta >= spikeThresh && recentAvg >= 70);
}

function checkAlerts() {
  var spikeAlert = checkBpmSpike();
  var hrAlert = (currentBpm !== null && currentBpm > hrMax);
  var anyAlert = (spikeAlert || hrAlert) && tremorDetected;

  if (anyAlert) {
    calmStart = 0;
    startVibrating();
    if (!lastAlertLogged) {
      logEvent("alert", {
        bpm: currentBpm,
        spike: spikeDelta,
        hrMax: hrMax,
        trmLvl: tremorLevel,
        reason: spikeAlert ? (hrAlert ? "spike+max" : "spike") : "max"
      });
      lastAlertLogged = true;
    }
  } else if (isVibrating) {
    if (calmStart === 0) calmStart = getTime();
    var calmSecs = getTime() - calmStart;
    if (calmSecs >= RECOVERY) {
      stopVibrating();
      calmStart = 0;
      lastAlertLogged = false;
      logEvent("recovery", {
        bpm: currentBpm,
        trmLvl: tremorLevel,
        calmSecs: Math.floor(calmSecs)
      });
    }
  } else {
    stopVibrating();
    lastAlertLogged = false;
  }
}

var lastAlertLogged = false;

function getTremorParams() {
  var diffMin = 0.08 - (tremorSens - 1) * 0.005;
  var diffMax = 0.22;
  var countThresh = 18 - (tremorSens - 1) * 1;
  return {diffMin: diffMin, diffMax: diffMax, countThresh: countThresh};
}

function draw() {
  var now = getTime();
  if (now - lastDraw < 0.3 && !tremorDetected && !isVibrating) return;
  lastDraw = now;

  var bpm = "---";
  if (currentBpm !== null) {
    bpm = currentBpm.toString();
  } else if (lastValidBpm) {
    bpm = lastValidBpm.toString();
  }
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
  g.drawString("T:" + tremorSens + "/10 t:" + tremorTicks + "/" + ACCEL_WIN + " c:" + lastConf, 4, 2);
  g.setFontAlign(1, -1);
  if (isVibrating && calmStart > 0) {
    var remain = RECOVERY - (getTime() - calmStart);
    if (remain < 0) remain = 0;
    g.drawString("CALM " + remain, W - 4, 2);
  } else {
    g.drawString(isVibrating ? "ALERT" : "OK", W - 4, 2);
  }

  g.setColor(g.theme.fg);
  g.setFont("Vector", 50).setFontAlign(0, 0);
  g.drawString(bpm, W / 2, H / 2 - 30);

  g.setFont("6x8", 2).setFontAlign(0, 0);
  g.drawString("bpm", W / 2, H / 2 + 18);

  g.setFont("6x8", 1).setFontAlign(0, 0);
  var deltaSign = spikeDelta >= 0 ? "+" : "";
  g.drawString("Spike: " + deltaSign + spikeDelta + "  Limit: +" + spikeThresh + "  [" + bpmHistory.length + "]", W / 2, H / 2 + 42);

  var alertY = H / 2 + 60;
  var spikeAlert = (currentBpm !== null && spikeDelta >= spikeThresh && currentBpm >= 70);
  if (tremorDetected) {
    g.setColor("#ff6600");
    g.setFont("6x8", 2).setFontAlign(0, 0);
    g.drawString("TREMOR", W / 2, alertY);
    alertY += 18;
  }
  if (spikeAlert) {
    g.setColor("#ff0000");
    g.setFont("6x8", 2).setFontAlign(0, 0);
    g.drawString("SPIKE +" + spikeDelta, W / 2, alertY);
    alertY += 18;
  }
  if (currentBpm !== null && currentBpm > hrMax) {
    g.setColor("#ff0000");
    g.setFont("6x8", 2).setFontAlign(0, 0);
    g.drawString("MAX " + hrMax, W / 2, alertY);
  }
}

Bangle.on('HRM', function(hrm) {
  lastConf = hrm.confidence || 0;
  if (hrm.bpm && hrm.confidence > 80) {
    if (lastValidBpm === null) {
      lastValidBpm = hrm.bpm;
      bpmLastValue = hrm.bpm;
      bpmStableCount = 2;
      lastBpmTime = getTime();
      currentBpm = hrm.bpm;
      bpmHistory.push({bpm: hrm.bpm, time: getTime()});
      logEvent("bpm", {bpm: hrm.bpm, conf: hrm.confidence});
    } else if (Math.abs(hrm.bpm - bpmLastValue) < 8) {
      bpmStableCount = 2;
      bpmLastValue = hrm.bpm;
      lastValidBpm = hrm.bpm;
      lastBpmTime = getTime();
      currentBpm = hrm.bpm;
      if (bpmHistory.length === 0 || bpmHistory[bpmHistory.length - 1].bpm !== hrm.bpm) {
        bpmHistory.push({bpm: hrm.bpm, time: getTime()});
      }
      logEvent("bpm", {bpm: hrm.bpm, conf: hrm.confidence});
    } else {
      bpmLastValue = hrm.bpm;
    }
  }

  if (getTime() - lastBpmTime > 10) {
    currentBpm = null;
    lastValidBpm = null;
    bpmStableCount = 0;
  }

  checkAlerts();
  draw();
});

Bangle.on('accel', function(acc) {
  var p = getTremorParams();
  var oldDiff = diffWindow[windowIdx];
  var newDiff = acc.diff;

  if (oldDiff > p.diffMin && oldDiff < p.diffMax) tremorTicks--;
  if (newDiff > p.diffMin && newDiff < p.diffMax) tremorTicks++;

  diffWindow[windowIdx] = newDiff;
  windowIdx = windowIdx + 1;
  if (windowIdx >= ACCEL_WIN) windowIdx = 0;

  tickCount = tickCount + 1;
  if (tickCount >= ACCEL_WIN) tickCount = ACCEL_WIN;

  if (tickCount >= ACCEL_WIN) {
    var isTremorNow = (tremorTicks >= p.countThresh);

    if (isTremorNow) {
      tremorStable = tremorStable + 1;
      if (tremorStable > 5) tremorStable = 5;
    } else {
      tremorStable = tremorStable - 1;
      if (tremorStable < 0) tremorStable = 0;
    }

    var prevDetected = tremorDetected;
    tremorDetected = (tremorStable >= 2);
    tremorLevel = Math.min(100, Math.round(tremorTicks * 100 / ACCEL_WIN));

    if (tremorDetected !== prevDetected) {
      logEvent("tremor", {
        trmDet: tremorDetected ? 1 : 0,
        trmLvl: tremorLevel,
        trmTicks: tremorTicks,
        conf: lastConf
      });
    }

    checkAlerts();
    draw();
  }
});

Bangle.on('touch', function(btn, e) {
  var barH = 20;
  if (e.y < barH + 8) {
    tremorSens = tremorSens + 1;
    if (tremorSens > 10) tremorSens = 1;
    logEvent("config", {tremorSens: tremorSens, spikeThresh: spikeThresh});
  } else if (e.y < g.getHeight() / 2 + 10) {
    if (spikeThresh < 40) spikeThresh = spikeThresh + 5;
    logEvent("config", {tremorSens: tremorSens, spikeThresh: spikeThresh});
  } else {
    if (spikeThresh > 5) spikeThresh = spikeThresh - 5;
    logEvent("config", {tremorSens: tremorSens, spikeThresh: spikeThresh});
  }
  draw();
});

setWatch(function() {
  logEvent("stop", {bpm: currentBpm, trmLvl: tremorLevel, entries: logEntries.length});
  flushLogFile();
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

initBLE();
logEvent("start", {tremorSens: tremorSens, spikeThresh: spikeThresh, hrMax: hrMax});

draw();

Bangle.loadWidgets();
Bangle.drawWidgets();
