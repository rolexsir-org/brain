// Central constants. Kept intentionally small.
export const SCHEMA_VERSION = 3;
export const DB_NAME = 'brain';
export const DB_VERSION = 1;
export const APP_NAME = 'Brain';
export const VERSION = '2.1.1';

export const CURRENCIES = ['₹', '$', '€', '£', 'AED', '₽', '¥', 'Rs '];
export const LOCALES = ['en-IN', 'en-US', 'en-GB', 'hi-IN', 'en-AU', 'es-ES', 'fr-FR', 'ar-SA'];

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Action verbs grouped for consistency (used by parser + quick actions).
export const TASK_INTENTS = [
  'add task', 'create task', 'add a task', 'new task', 'add to-do', 'todo', 'to-do',
  'i need to', 'i have to', 'i must', 'need to', 'have to', 'got to', 'remember to',
  'submit', 'finish', 'complete project'
];
