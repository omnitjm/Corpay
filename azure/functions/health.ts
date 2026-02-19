import { HttpRequest, HttpResponseInit, InvocationContext, app } from '@azure/functions';

/**
 * Azure Function: Health Check (HTTP Trigger)
 *
 * Simple endpoint to verify the function app is running.
 * URL: https://<your-function-app>.azurewebsites.net/api/health
 */
async function health(_request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  return {
    status: 200,
    jsonBody: {
      status: 'ok',
      service: 'corpayone-netsuite-integration',
      runtime: 'azure-functions',
      timestamp: new Date().toISOString(),
    },
  };
}

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: health,
});
