import electronLog from 'electron-log/main';

/** File + console logging (userData/logs/main.log). */
electronLog.initialize();
electronLog.transports.file.maxSize = 5 * 1024 * 1024;
electronLog.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'warn';

export const log = electronLog;
