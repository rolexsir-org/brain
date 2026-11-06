// Central constants. Kept intentionally small.
export const SCHEMA_VERSION = 4;
export const DB_NAME = 'brain';
export const DB_VERSION = 1;
export const APP_NAME = 'Brain';
export const VERSION = '2.2.0';

export const CURRENCIES = ['₹', '$', '€', '£', 'AED', '₽', '¥', 'Rs '];
export const LOCALES = ['en-IN', 'en-US', 'en-GB', 'hi-IN', 'en-AU', 'es-ES', 'fr-FR', 'ar-SA'];

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Instagram Business Integration — constants aligned with Meta Graph API v21.0
export const SCHEMA_VERSION_INSTAGRAM = 4;
export const INSTAGRAM_API_VERSION = 'v21.0';
export const INSTAGRAM_OAUTH_DIALOG = 'https://www.facebook.com/v21.0/dialog/oauth';
export const INSTAGRAM_TOKEN_ENDPOINT = 'https://graph.facebook.com/v21.0/oauth/access_token';
export const INSTAGRAM_GRAPH_ENDPOINT = 'https://graph.facebook.com/v21.0';
export const INSTAGRAM_REQUIRED_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
  'business_management'
];
export const INSTAGRAM_MIN_SCOPES = ['instagram_basic', 'instagram_content_publish'];
export const INSTAGRAM_MEDIA_REQUIREMENTS = Object.freeze({
  formats: ['mp4', 'mov', 'quicktime'],
  mimeTypes: ['video/mp4', 'video/quicktime', 'video/mov', 'video/x-m4v'],
  minDurationSec: 3,
  maxDurationSec: 900, // 15 min max; Reels recommended ≤90s
  recommendedMaxDurationSec: 90,
  minWidth: 320,
  minHeight: 480,
  maxFileSizeBytes: 1000 * 1024 * 1024, // 1GB per Meta docs
  clientMaxFileSizeBytes: 250 * 1024 * 1024, // client-side sanity cap
  allowedAspectRatios: [
    { label: '9:16', w: 9, h: 16, tolerance: 0.08 },
    { label: '4:5', w: 4, h: 5, tolerance: 0.08 },
    { label: '1:1', w: 1, h: 1, tolerance: 0.08 }
  ],
  captionMaxLength: 2200,
  hashtagMaxCount: 30,
  hashtagMaxLength: 80
});
export const INSTAGRAM_PUBLISH_STATES = ['draft', 'ready', 'pending', 'publishing', 'published', 'failed', 'scheduled'];

// Action verbs grouped for consistency (used by parser + quick actions).
export const TASK_INTENTS = [
  'add task', 'create task', 'add a task', 'new task', 'add to-do', 'todo', 'to-do',
  'i need to', 'i have to', 'i must', 'need to', 'have to', 'got to', 'remember to',
  'submit', 'finish', 'complete project'
];
