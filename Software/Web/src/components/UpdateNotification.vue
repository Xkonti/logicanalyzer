<template>
  <!-- Floating update button -->
  <q-btn
    v-if="hasUpdate"
    round
    color="deep-orange"
    icon="system_update"
    class="update-notification-btn"
    @click="showDialog = true"
  >
    <q-tooltip>New version available!</q-tooltip>
  </q-btn>

  <!-- Update dialog -->
  <q-dialog v-model="showDialog" persistent>
    <q-card style="min-width: 400px; max-width: 600px">
      <q-card-section class="row items-center">
        <q-icon name="system_update" size="md" color="deep-orange" class="q-mr-md" />
        <div class="text-h6">Update Available</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-separator />

      <q-card-section>
        <div class="text-body1 q-mb-md">
          A new version of Logic Analyzer is available!
        </div>
        <div class="text-body2 text-grey-7 q-mb-md">
          Current version: <strong>{{ currentVersion }}</strong><br />
          Latest version: <strong class="text-deep-orange">{{ latestVersion }}</strong>
        </div>

        <!-- Changelog -->
        <div v-if="changelog.length > 0" class="q-mt-md">
          <div class="text-subtitle2 q-mb-sm">What's new:</div>
          <div
            v-for="version in changelog"
            :key="version.version"
            class="q-mb-md"
          >
            <div class="text-weight-bold">
              Version {{ version.version }}
              <span class="text-grey-6 text-weight-regular">
                ({{ formatDate(version.releaseDate) }})
              </span>
            </div>
            <ul class="q-pl-md q-my-xs">
              <li v-for="(change, idx) in version.changes" :key="idx">
                {{ change }}
              </li>
            </ul>
          </div>
        </div>
      </q-card-section>

      <q-separator />

      <q-card-section class="bg-warning text-dark">
        <div class="text-body2">
          <q-icon name="warning" class="q-mr-sm" />
          <strong>Warning:</strong> Updating will reload the page and any unsaved data
          will be lost.
        </div>
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Not Now" color="grey-7" v-close-popup />
        <q-btn
          unelevated
          label="Update Now"
          color="deep-orange"
          @click="handleUpdate"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useVersionCheck } from 'src/composables/useVersionCheck'

const {
  currentVersion,
  latestVersion,
  hasUpdate,
  getChangelog,
  updateApp,
} = useVersionCheck()

const showDialog = ref(false)

const changelog = computed(() => getChangelog())

const formatDate = (dateString) => {
  if (!dateString) return ''
  const date = new Date(dateString)
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

const handleUpdate = () => {
  updateApp()
}
</script>

<style scoped>
.update-notification-btn {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 9999;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(255, 87, 34, 0.7);
  }
  50% {
    box-shadow: 0 0 0 10px rgba(255, 87, 34, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(255, 87, 34, 0);
  }
}
</style>
