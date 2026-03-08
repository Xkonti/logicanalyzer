<template>
  <q-layout view="hHh lpr fFf">
    <q-header elevated class="bg-dark">
      <q-toolbar>
        <q-toolbar-title class="text-weight-bold">LogicAnalyzer</q-toolbar-title>
        <CaptureToolbar
          :drawer-open="rightDrawerOpen"
          @toggle-drawer="rightDrawerOpen = !rightDrawerOpen"
        />
        <q-space />
        <ConnectionPanel />
      </q-toolbar>
    </q-header>

    <q-drawer v-model="rightDrawerOpen" side="right" bordered :width="360" class="bg-dark">
      <CapturePanel />
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup>
import { ref } from 'vue'
import ConnectionPanel from 'src/components/connection/ConnectionPanel.vue'
import CaptureToolbar from 'src/components/capture/CaptureToolbar.vue'
import CapturePanel from 'src/components/capture/CapturePanel.vue'

const rightDrawerOpen = ref(false)
</script>
