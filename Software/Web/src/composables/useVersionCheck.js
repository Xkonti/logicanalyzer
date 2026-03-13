import { ref, onMounted, onUnmounted } from 'vue'
import axios from 'axios'

/**
 * Composable for checking application version updates
 * Polls version.json periodically and notifies when a new version is available
 */
export function useVersionCheck() {
  const currentVersion = ref(import.meta.env.VITE_APP_VERSION || '0.0.0')
  const latestVersion = ref(null)
  const versionInfo = ref(null)
  const hasUpdate = ref(false)
  const checkInterval = ref(null)
  const baseUrl = ref(import.meta.env.VITE_APP_BASE_URL || '')

  /**
   * Fetches the version.json file from the server
   */
  const fetchVersionInfo = async () => {
    try {
      // Add cache-busting timestamp to ensure we get fresh data
      const timestamp = Date.now()
      const url = `${baseUrl.value}/version.json?t=${timestamp}`

      const response = await axios.get(url, {
        // Prevent axios from caching
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
      })

      if (response.data) {
        latestVersion.value = response.data.currentVersion
        versionInfo.value = response.data

        // Check if update is available
        hasUpdate.value = isNewerVersion(latestVersion.value, currentVersion.value)
      }
    } catch (error) {
      console.error('Failed to fetch version info:', error)
      // Fail silently - version checking is not critical
    }
  }

  /**
   * Compares two semantic versions
   * Returns true if newVersion is greater than currentVersion
   */
  const isNewerVersion = (newVersion, currentVersion) => {
    if (!newVersion || !currentVersion) return false

    const newParts = newVersion.split('.').map(Number)
    const currentParts = currentVersion.split('.').map(Number)

    for (let i = 0; i < Math.max(newParts.length, currentParts.length); i++) {
      const newPart = newParts[i] || 0
      const currentPart = currentParts[i] || 0

      if (newPart > currentPart) return true
      if (newPart < currentPart) return false
    }

    return false
  }

  /**
   * Gets changelog entries between current version and latest version
   */
  const getChangelog = () => {
    if (!versionInfo.value || !versionInfo.value.versions) return []

    const versions = versionInfo.value.versions
    const changelog = []

    for (const version of versions) {
      // Include all versions newer than current
      if (isNewerVersion(version.version, currentVersion.value)) {
        changelog.push(version)
      }
    }

    // Sort by version descending (newest first)
    return changelog.sort((a, b) => {
      if (isNewerVersion(a.version, b.version)) return -1
      if (isNewerVersion(b.version, a.version)) return 1
      return 0
    })
  }

  /**
   * Starts periodic version checking
   * @param {number} intervalMs - Check interval in milliseconds (default: 1 hour)
   */
  const startChecking = (intervalMs = 60 * 60 * 1000) => {
    // Check immediately on start
    fetchVersionInfo()

    // Then check periodically
    checkInterval.value = setInterval(() => {
      fetchVersionInfo()
    }, intervalMs)
  }

  /**
   * Stops periodic version checking
   */
  const stopChecking = () => {
    if (checkInterval.value) {
      clearInterval(checkInterval.value)
      checkInterval.value = null
    }
  }

  /**
   * Reloads the page to get the new version
   */
  const updateApp = () => {
    window.location.reload()
  }

  // Auto-start checking on mount
  onMounted(() => {
    startChecking()
  })

  // Clean up on unmount
  onUnmounted(() => {
    stopChecking()
  })

  return {
    currentVersion,
    latestVersion,
    hasUpdate,
    versionInfo,
    fetchVersionInfo,
    getChangelog,
    startChecking,
    stopChecking,
    updateApp,
  }
}
