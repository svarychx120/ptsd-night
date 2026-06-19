# PTSD Night Watch

Monitors your heart rate in real time. If your BPM exceeds the configured
threshold (default 100), the watch vibrates continuously until your heart rate
drops back below the threshold.

## Usage

- Open the app to start heart rate monitoring
- Current BPM is displayed in large text
- Swipe **up** to increase the threshold (+5 BPM)
- Swipe **down** to decrease the threshold (-5 BPM)
- Press the button to exit

## How it works

The app reads heart rate data from the Bangle.js 2 optical sensor. When BPM
rises above the threshold, a repeating vibration pattern starts. The vibration
continues without pause until BPM falls back below the threshold, providing a
physical alert that can help during PTSD episodes, panic attacks, or high-stress
moments.
