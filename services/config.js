/**
 * Copyright 2021-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

"use strict";

// Use dotenv to read .env vars into Node
require("dotenv").config();

// Required environment variables
const ENV_VARS = [
  "ACCESS_TOKEN",
  "APP_SECRET",
  "VERIFY_TOKEN",
];

const MEDIA_ID_ENV_VARS = [
  "GROCERIES_MEDIA_ID",
  "STRAWBERRIES_MEDIA_ID",
  "SHEET_PAN_DINNER_MEDIA_ID",
  "SALAD_BOWL_MEDIA_ID",
];
const MEDIA_ID_PLACEHOLDER = "1234567890";

function getMediaId(key) {
  const value = process.env[key];
  return value && value.trim();
}

module.exports = Object.freeze({
  // Application information
  appSecret: process.env.APP_SECRET,
  accessToken: process.env.ACCESS_TOKEN,
  verifyToken: process.env.VERIFY_TOKEN,
  geminiApiKey: process.env.GEMINI_API_KEY,
  nvidiaApiKey: process.env.NVIDIA_API_KEY,

  // WhatsApp media uploaded for outbound templates
  groceriesMediaId: getMediaId("GROCERIES_MEDIA_ID"),
  strawberriesMediaId: getMediaId("STRAWBERRIES_MEDIA_ID"),
  sheetPanDinnerMediaId: getMediaId("SHEET_PAN_DINNER_MEDIA_ID"),
  saladBowlMediaId: getMediaId("SALAD_BOWL_MEDIA_ID"),

  // Server configuration
  port: process.env.PORT || 8080,
  redisHost: process.env.REDIS_HOST || "localhost",
  redisPort: process.env.REDIS_PORT || 6379,

  checkEnvVariables: function () {
    ENV_VARS.forEach(function (key) {
      if (!process.env[key]) {
        console.warn("WARNING: Missing the environment variable " + key);
      }
    });
    if (!process.env.GEMINI_API_KEY) {
      console.warn("WARNING: Missing GEMINI_API_KEY. AI conversation features will be disabled until set.");
    }
  }
});
