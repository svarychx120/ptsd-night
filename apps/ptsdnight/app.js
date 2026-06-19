var threshold = 100;
var isVibrating = false;
var vibrationInterval = null;
var currentBpm = null;
var lastValidBpm = null;

function startVibrating() {
  if (isVibrating) return;
  isVibrating = true;
  vibrationInterval = setInterval(() => Bangle.buzz(400, 1), 450);
}

function stopVibrating() {
  if (!isVibrating) return;
  isVibrating = false;
  if (vibrationInterval) {
    clearInterval(vibrationInterval);
    vibrationInterval = null;
  }
}

function draw() {
  var bpm = currentBpm !== null ? currentBpm.toString() : (lastValidBpm ? lastValidBpm.toString() : "---");

  g.clear();
  g.setColor(g.theme.fg);

  g.setFont("Vector", 56).setFontAlign(0, 0);
  g.drawString(bpm, g.getWidth() / 2, g.getHeight() / 2 - 35);

  g.setFont("6x8", 2).setFontAlign(0, 0);
  g.drawString("bpm", g.getWidth() / 2, g.getHeight() / 2 + 15);

  g.setFont("6x8", 1).setFontAlign(0, 0);
  g.drawString("Threshold: " + threshold, g.getWidth() / 2, g.getHeight() / 2 + 45);

  if (isVibrating) {
    g.setColor("#ff0000");
    g.setFont("6x8", 2).setFontAlign(0, 0);
    g.drawString("HIGH BPM!", g.getWidth() / 2, g.getHeight() / 2 + 70);
  }
}

Bangle.on('HRM', function(hrm) {
  if (hrm.bpm && hrm.confidence > 50) {
    lastValidBpm = hrm.bpm;
    currentBpm = hrm.bpm;

    if (currentBpm > threshold) {
      startVibrating();
    } else {
      stopVibrating();
    }
  }
  draw();
});

Bangle.setUI({mode: "updown"}, function(dir) {
  if (dir < 0) {
    if (threshold > 45) threshold -= 5;
  } else if (dir > 0) {
    if (threshold < 180) threshold += 5;
  }
  draw();
});

g.clear();
g.setFont("6x8", 2).setFontAlign(0, 0);
g.drawString("Starting...", g.getWidth() / 2, g.getHeight() / 2);

Bangle.setHRMPower(1, 'ptsdnight');
draw();

Bangle.loadWidgets();
Bangle.drawWidgets();
