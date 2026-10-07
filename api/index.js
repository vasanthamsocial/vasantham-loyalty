// Vercel entry point: the backend runs as one serverless function.
// The three apps are served as static files by Vercel (see vercel.json).
import { createApp } from '../backend/src/server.js';

export default createApp();
