import pino, { type Logger, type LoggerOptions } from 'pino';

export function createLogger(level: string): Logger {
  const options: LoggerOptions = {
    level,
    base: undefined
  };

  // MCP stdio requires stdout to be reserved for JSON-RPC frames only.
  // Send logs to stderr to avoid corrupting protocol messages.
  const stderrDestination = pino.destination({ fd: 2, sync: false });

  if (process.env.MCP_LOG_PRETTY === 'true') {
    return pino(
      options,
      pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: false,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
          destination: 2
        }
      })
    );
  }

  return pino(options, stderrDestination);
}
