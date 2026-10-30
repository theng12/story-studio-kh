# Offline-first notes

Story Studio's supported desktop build is macOS arm64. The app and its local
project data can be used without internet access. Some operations also need a
reachable service; that service can be on the local network and does not
necessarily need the public internet.

## Available locally

- **Interface font:** Inter is bundled in `frontend/public/fonts/inter/` and
  loaded by `frontend/assets/css/fonts.css`.
- **Audio and video tools:** FFmpeg and ffprobe are packaged from
  `bundled/ffmpeg/` into the app's `Contents/Resources/ffmpeg/` for local
  audio and video work.
- **Optional duplicate screening:** EmbeddingGemma 2 ONNX (8-bit text, FP32
  vision) runs on the Mac running Story. It compares scene images and titles;
  it is off by default and provides warnings, not a requirement to upload.
  If screening is off, unavailable or fails, the result is `not_checked`, not
  a pass.

The model weights and native ONNX runtime are separate from the app's DMG. The
SSD kit carries them in its `EmbeddingGemma` folder. Run
`packaging/kit-story/Install Story Studio.command` from the kit: it installs
the app and copies the model and runtime into Story's `embedding-models` data
folder, checking each file against the kit's SHA-256 list. It does not enable
screening. If the kit lacks the folder, the app is still installed, but the
model must be obtained separately before screening can run. The app also offers
a download of the pinned model and runtime when internet access is available.

## Services

- **GenStudio:** catalog requests and generation use the configured GenStudio
  service. The default address is `http://127.0.0.1:8787`; a reachable local
  service can be used without public internet. If it is unavailable, those
  requests cannot complete.
- **YouTube:** uploading and other YouTube account operations require access to
  YouTube's services.
