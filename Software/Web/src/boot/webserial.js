import { ref } from 'vue'
import { defineBoot } from '#q-app/wrappers'
import { Notify } from 'quasar'

export const webSerialAvailable = ref(typeof navigator !== 'undefined' && !!navigator.serial)

export default defineBoot(() => {
  if (!webSerialAvailable.value) {
    Notify.create({
      type: 'warning',
      message:
        'Web Serial API is not available. Use Chrome or Edge for USB connections, or connect via WiFi.',
      position: 'top',
      timeout: 0,
      actions: [{ label: 'Dismiss', color: 'dark' }],
    })
  }
})
