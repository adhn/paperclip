const response = await fetch('http://127.0.0.1:3100/api/health', {signal: AbortSignal.timeout(4000)});
process.exit(response.ok && (await response.json()).status === 'ok' ? 0 : 1);
