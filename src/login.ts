#!/usr/bin/env node
// One-time setup: opens the dedicated Chrome profile on Flow Music so the user can sign in by hand.
import { PROFILE_DIR, getMusicPage } from "./chrome.js";

const page = await getMusicPage();
await page.bringToFront();
console.log(`Chrome is open on ${page.url()}`);
console.log(`Profile: ${PROFILE_DIR}`);
console.log("Sign in to Google in that window. The session is kept for next time; you can close the window afterwards.");
process.exit(0);
