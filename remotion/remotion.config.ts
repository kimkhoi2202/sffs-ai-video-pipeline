import { Config } from "@remotion/cli/config";

// HQ, parity with the Python master's encode intent: yuv420p, high-quality CRF.
Config.setVideoImageFormat("jpeg");
Config.setPixelFormat("yuv420p");
Config.setCrf(16);
