# Projector Mapper

A projection-mapping app that runs in your browser, with nothing to install. Trace shapes over real-world objects (walls, boxes, stage props, windows), give each one an animated look, image or video, and send the result to a projector. Anything outside your shapes stays black, so light lands only on the objects.

## Run it

Use any static web server from this folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000 in Chrome or Edge
```

(Opening `index.html` straight from the disk mostly works, but a server is needed for the output window to sync reliably.)

## Setting up a show

1. **Connect the projector** as a second display (extended, not mirrored).
2. Click **Open output window**, drag it onto the projector, and **double-click it** to go fullscreen.
3. Press **G** for the test grid to check that the projector covers the area you want.
4. Pick **Rect**, **Circle** or **Polygon** and draw roughly where your object is. Then use **Select** and drag the yellow dots until the light lines up exactly with the edges you see on the real object.
   - Double-click an edge to add a point; right-click a point to remove it.
   - Arrow keys nudge the selected point or shape (Shift = 10 px).
   - The **Alignment grid** effect numbers each corner, which helps with fine-tuning.
5. Choose an **Effect** for each shape: solid, pulse, strobe, fade, rotating gradient, rainbow, chase stripes, wipe, sparkle, neon outline, or your own **image/video**.
6. Set the **BPM** or tap **T** to the music. Use **Beat offset** to make effects ripple from one shape to the next.
7. Turn on **Auto show** for hands-free looks that change every 8 beats, or turn on **Mic** and tick *React to sound* on the shapes that should follow the music.

With only one display (a mirrored projector), use **Perform (H)** to hide the editor and go fullscreen.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| V / P / R / C | Select / Polygon / Rect / Circle tool |
| Enter, Esc | Close polygon, cancel |
| Del | Delete shape |
| Ctrl+D, Ctrl+Z, Ctrl+S | Duplicate, undo, save |
| H | Perform mode on/off |
| B | Blackout |
| T | Tap tempo |
| G | Test grid |

## Saving

Your layout saves automatically in the browser, and uploaded images and videos are kept too. **Save** downloads a `.json` project file with your shapes and settings; media files are not included in it.
