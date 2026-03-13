# Version Check System

This application includes an automatic version check system that notifies users when a new version is available. This is particularly useful for SPAs that may remain open for extended periods (weeks or months).

## How It Works

1. **Version Manifest**: A `version.json` file in the `public/` directory contains version information
2. **Periodic Checking**: The app checks this file every hour (configurable)
3. **User Notification**: When a new version is detected, a pulsing orange button appears in the bottom-right corner
4. **Update Dialog**: Clicking the button shows a dialog with changelog and update options
5. **Page Reload**: Updating reloads the page to fetch the new version

## Configuration

### Build-Time Configuration

The app version is automatically injected from `package.json` during build. You can also configure the base URL for fetching `version.json`:

```bash
# Default (empty, uses relative path)
npm run build

# With custom base URL
VITE_APP_BASE_URL=https://example.com npm run build
```

### Version Manifest (`public/version.json`)

The version manifest file should be manually updated when deploying a new version:

```json
{
  "currentVersion": "0.1.0",
  "versions": [
    {
      "version": "0.1.0",
      "releaseDate": "2024-03-15",
      "changes": [
        "Added new feature X",
        "Fixed bug Y",
        "Improved performance of Z"
      ]
    },
    {
      "version": "0.0.1",
      "releaseDate": "2024-03-09",
      "changes": [
        "Initial release"
      ]
    }
  ]
}
```

**Important**: Always update both:
1. `currentVersion` field to match the latest version
2. Add a new entry to the `versions` array with the changes

### Check Interval

The default check interval is 1 hour (3,600,000 ms). To customize this, edit `src/composables/useVersionCheck.js`:

```javascript
// Check every 30 minutes instead
startChecking(30 * 60 * 1000)
```

## Deployment Workflow

1. Update `package.json` version number
2. Build the application: `npm run build`
3. Update `public/version.json` with the new version and changelog
4. Deploy the built files
5. Users with the app open will be notified within 1 hour

## Files Involved

- **`public/version.json`** - Version manifest (deploy this with your build)
- **`src/composables/useVersionCheck.js`** - Version checking logic
- **`src/components/UpdateNotification.vue`** - Update notification UI
- **`src/App.vue`** - Integrates the notification component
- **`quasar.config.js`** - Injects version from package.json

## User Experience

1. **No Update**: No UI change, silent checking in background
2. **Update Available**: Orange pulsing button appears in bottom-right
3. **Click Button**: Dialog shows version info and changelog
4. **Update**: Click "Update Now" to reload the page
5. **Dismiss**: Click "Not Now" to continue with current version (will be reminded on next check)

## Technical Details

- **Version Comparison**: Uses semantic versioning (major.minor.patch)
- **Cache Busting**: Adds timestamp to version.json requests to prevent caching
- **Error Handling**: Fails silently if version.json cannot be fetched
- **Cleanup**: Properly clears intervals when component unmounts
- **No Server Required**: Works with static file hosting (GitHub Pages, S3, etc.)

## Testing

To test the version check system locally:

1. Run the dev server: `npm run dev`
2. Open the app in your browser
3. Manually edit `public/version.json` and increase the version number
4. Wait up to 1 hour (or reduce the interval for testing)
5. The update notification should appear

For faster testing, temporarily reduce the check interval to 10 seconds:

```javascript
// In src/composables/useVersionCheck.js
startChecking(10 * 1000) // Check every 10 seconds
```

Remember to restore the original interval before committing!
