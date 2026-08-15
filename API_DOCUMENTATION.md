# Automation System External API Documentation

## Overview
This API allows external systems (Google Scripts, Postman, Zapier, etc.) to interact with the automation platform programmatically.

## Base URL
```
https://waqas-ai-studio.waqaskhan1437.workers.dev
```

## Authentication
All API requests require an API key. API keys are managed per user with granular permission levels.

### API Key Permissions
- `read`: Read-only access (view automations, jobs, status)
- `write`: Create and edit automations, trigger jobs
- `admin`: Full management access including user management
- `full`: Complete system access including runner commands

### Authentication Methods
1. **Header Authentication** (Recommended)
   ```http
   X-API-Key: your_api_key_here
   ```

2. **Query Parameter**
   ```http
   ?api_key=your_api_key_here
   ```

---

## API Key Management

### List API Keys
List all API keys for the authenticated user
```http
GET /api/keys
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Zapier Integration",
      "key_prefix": "sk_live_abc123",
      "permissions": "write",
      "created_at": "2024-01-01T00:00:00Z",
      "last_used_at": "2024-01-02T12:00:00Z",
      "expires_at": null,
      "is_active": true
    }
  ]
}
```

### Create API Key
Create a new API key with specific permissions
```http
POST /api/keys
Content-Type: application/json

{
  "name": "Postman Testing",
  "permissions": "full",
  "expires_days": 30
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 2,
    "name": "Postman Testing",
    "key": "sk_live_xyz789_actual_full_key",
    "key_prefix": "sk_live_xyz789",
    "permissions": "full",
    "created_at": "2024-01-03T00:00:00Z"
  }
}
```

⚠️ **IMPORTANT:** Store the full API key securely - it will only be shown once!

### Revoke API Key
```http
DELETE /api/keys/:key_id
```

### Rotate API Key
Invalidate existing key and generate a new one
```http
POST /api/keys/:key_id/rotate
```

---

## Webhook Triggers

### Trigger Automation
Trigger an automation run externally
```http
POST /api/webhook/:webhook_id/trigger
Content-Type: application/json

{
  "parameters": {
    "video_url": "https://example.com/video.mp4",
    "title": "My Uploaded Video",
    "custom_field": "value"
  },
  "callback_url": "https://your-system.com/webhook/callback"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "job_id": 12345,
    "status": "queued",
    "created_at": "2024-01-01T00:00:00Z"
  }
}
```

### Get Job Status
```http
GET /api/webhook/:webhook_id/status/:job_id
```

**Response:**
```json
{
  "success": true,
  "data": {
    "job_id": 12345,
    "status": "completed",
    "progress": 100,
    "video_url": "https://processed-video-url.com/output.mp4",
    "output_data": {
      "processed_videos": 5,
      "duration": 120
    },
    "created_at": "2024-01-01T00:00:00Z",
    "completed_at": "2024-01-01T00:05:00Z"
  }
}
```

### Send Runner Command
Send direct commands to connected runners
```http
POST /api/webhook/:webhook_id/command
Content-Type: application/json

{
  "command": "process_image",
  "parameters": {
    "image_url": "https://example.com/image.jpg",
    "operations": ["resize", "watermark"],
    "width": 1080,
    "height": 1920
  }
}
```

**Available Commands:**
- `process_image`: Image processing (resize, crop, watermark)
- `upload_media`: Upload media to cloud storage
- `fetch_videos`: Fetch videos from URLs/playlists
- `execute_script`: Run custom scripts
- `cancel_job`: Cancel a running job

### Get Runner Status
```http
GET /api/webhook/:webhook_id/runner/status
```

---

## Automation Management

### List Automations
```http
GET /api/automations
```

### Create Automation
```http
POST /api/automations
Content-Type: application/json

{
  "name": "Daily Video Uploader",
  "description": "Automatically uploads videos daily",
  "schedule": "0 9 * * *",
  "config": {
    "source": "youtube",
    "playlist_id": "PL123456789"
  }
}
```

### Get Automation Details
```http
GET /api/automations/:id
```

### Update Automation
```http
PUT /api/automations/:id
```

### Delete Automation
```http
DELETE /api/automations/:id
```

---

## Job Management

### List Jobs
```http
GET /api/jobs
```

### Get Job Details
```http
GET /api/jobs/:id
```

### Cancel Job
```http
POST /api/jobs/:id/cancel
```

---

## Audit Logs

All API requests are automatically logged with:
- User ID and API Key ID
- IP Address and User Agent
- Request/Response size
- Duration
- Status code and error messages
- Timestamp

Logs are retained for 90 days.

---

## Example Integrations

### Postman Example
1. Create an API key with `write` permissions
2. Set Header: `X-API-Key: your_key_here`
3. Send POST request to `/api/keys` to verify

### Zapier Example
1. Create API key with `full` permissions
2. Use Webhook by Zapier action
3. Set URL to `https://waqas-ai-studio.waqaskhan1437.workers.dev/api/webhook/your_webhook_id/trigger`
4. Add your API key in headers

### Google Apps Script Example
```javascript
function triggerAutomation(webhookId, apiKey) {
  const url = `https://waqas-ai-studio.waqaskhan1437.workers.dev/api/webhook/${webhookId}/trigger`;
  
  const options = {
    method: 'post',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({
      parameters: {
        video_url: 'https://example.com/video.mp4'
      }
    })
  };
  
  const response = UrlFetchApp.fetch(url, options);
  return JSON.parse(response.getContentText());
}
```

---

## Rate Limits
- Free tier: 100 requests/hour
- Pro tier: 1000 requests/hour
- Enterprise: Custom limits

---

## Error Codes
| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid parameters |
| 401 | Unauthorized - Invalid or missing API key |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource does not exist |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Server Error - Internal system error |

---

## Support
For API issues or questions:
- Check the documentation first
- Review audit logs for request details
- Contact support with request IDs from responses
