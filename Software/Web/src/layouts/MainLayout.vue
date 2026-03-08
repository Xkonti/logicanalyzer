<template>
  <q-layout view="hHh lpr fFf">
    <q-header elevated class="bg-dark">
      <q-toolbar>
        <q-toolbar-title class="text-weight-bold">LogicAnalyzer</q-toolbar-title>
        <q-space />
        <ConnectionPanel />
      </q-toolbar>
    </q-header>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup>
import ConnectionPanel from 'src/components/connection/ConnectionPanel.vue'
</script>
