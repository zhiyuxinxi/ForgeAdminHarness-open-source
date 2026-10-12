import assert from 'node:assert/strict';
import test from 'node:test';
import contract from '../docker/harness/forge-ui-contract.json' with { type: 'json' };
import { auditForgeUiContract, validateForgeUiContract } from '../docker/harness/forge-ui-contract.mjs';

function source(path, content, status = 'added') {
  return { path, content, status };
}

test('canonical manifest is versioned and covers every Forge UI owner', () => {
  assert.equal(validateForgeUiContract(contract), contract);
  assert.equal(contract.contractVersion, '2026.09.03.1');
  assert.deepEqual(new Set(Object.keys(contract.canonicalOwners)), new Set([
    'AiCrudPage', 'AiForm', 'DictSelect/DictTag', 'AuthImage', 'request', 'v-hasPermi',
    'dangerousConfirmation', 'token', 'loading-empty-error-busy', 'upload',
  ]));
});

test('canonical business UI, API adapter, protected image, permissions, and reuse consumers pass', () => {
  const files = [
    source('forge-admin-ui/src/api/business/order.ts', `
import request from '@/utils/request'
export const orderApi = { page: (params) => request.get('/business/order/page', { params }) }
`),
    source('forge-admin-ui/src/components/business/OrderBadge.vue', `
<template><n-tag>{{ label }}</n-tag></template>
<script setup>defineProps({ label: String })</script>
`),
    source('forge-admin-ui/src/views/business/order/index.vue', `
<template>
  <AiCrudPage :api-config="orderApi">
    <template #avatar="{ row }"><AuthImage :file-id="row.avatarFileId" /></template>
    <template #actions="{ row }">
      <NPopconfirm @positive-click="remove(row.id)">
        <template #trigger><NButton v-hasPermi="['business:order:remove']">删除</NButton></template>
      </NPopconfirm>
    </template>
  </AiCrudPage>
  <OrderBadge label="订单" />
</template>
<script setup>
import { orderApi } from '@/api/business/order'
import OrderBadge from '@/components/business/OrderBadge.vue'
import AuthImage from '@/components/common/AuthImage.vue'
</script>
`),
    source('forge-admin-ui/src/views/business/invoice/index.vue', `
<template><AiCrudPage><OrderBadge label="发票" /></AiCrudPage></template>
<script setup>import OrderBadge from '@/components/business/OrderBadge.vue'</script>
`),
  ];
  const receipt = auditForgeUiContract({ files, contract });
  assert.equal(receipt.ok, true, JSON.stringify(receipt, null, 2));
  assert.deepEqual(receipt.findings, []);
  assert.deepEqual(receipt.obligations, []);
  assert.equal(receipt.summary.addedBusinessFiles, 3);
});

test('business views cannot depend directly on request while src/api adapters retain transport ownership', () => {
  const directView = source('forge-admin-ui/src/views/business/order/index.vue', `
<template><AiCrudPage :api-config="orderApi" /></template>
<script setup>
import request from '@/utils/request'
const orderApi = { page: (params) => request.get('/business/order/page', { params }) }
</script>
`);
  const directReceipt = auditForgeUiContract({ files: [directView], contract });
  assert.equal(directReceipt.ok, false);
  assert.ok(directReceipt.findings.some((item) => item.ruleId === 'UI-HTTP-001'
    && item.message.includes('must call a src/api adapter')));

  const relativeDirectView = source('forge-admin-ui/src/views/business/invoice/index.vue', `
<template><AiCrudPage /></template>
<script setup>
const request = require('../../../utils/request')
const load = () => request.get('/business/invoice/page')
</script>
`);
  const relativeReceipt = auditForgeUiContract({ files: [relativeDirectView], contract });
  assert.equal(relativeReceipt.ok, false);
  assert.ok(relativeReceipt.findings.some((item) => item.ruleId === 'UI-HTTP-001'));

  const adapter = source('forge-admin-ui/src/api/business/order.ts', `
import request from '@/utils/request'
export const orderApi = { page: (params) => request.get('/business/order/page', { params }) }
`);
  const view = source('forge-admin-ui/src/views/business/order/index.vue', `
<template><AiCrudPage :api-config="orderApi" /></template>
<script setup>import { orderApi } from '@/api/business/order'</script>
`);
  const adapterReceipt = auditForgeUiContract({ files: [adapter, view], contract });
  assert.equal(adapterReceipt.ok, true, JSON.stringify(adapterReceipt, null, 2));
  assert.deepEqual(adapterReceipt.findings, []);
});

test('unsafe new business UI is blocked and reuse gaps remain explicit obligations', () => {
  const files = [
    source('forge-admin-ui/src/api/business/order.ts', `
import axios from 'axios'
export const remove = (id) => axios.delete('/business/order/' + id)
`),
    source('forge-admin-ui/src/components/business/OrphanPanel.vue', '<template><section>孤立组件</section></template>'),
    source('forge-admin-ui/src/views/business/order/index.vue', `
<template>
  <div class="panel" style="color: rgb(255, 0, 0)">
    <el-table />
    <span @click="openRow">打开</span>
    <button @click="handleDelete">删除</button>
    <img :src="row.avatarFileId" />
    <n-pagination v-model:page="pageNum" />
    <n-form :model="formModel" />
    <n-upload action="/api/file/upload" />
  </div>
</template>
<script setup>
import { ElTable } from 'element-plus'
fetch('/api/business/order/page')
window.confirm('delete?')
localStorage.setItem('access_token', token)
const statusOptions = [{ label: '启用', value: 1 }]
</script>
<style scoped>.panel { border-color: #ff0000; }</style>
`),
  ];
  const receipt = auditForgeUiContract({ files, contract });
  assert.equal(receipt.ok, false);
  const ruleIds = new Set(receipt.findings.map((item) => item.ruleId));
  for (const id of [
    'UI-DESIGN-001', 'UI-HTTP-001', 'UI-DIALOG-001', 'UI-A11Y-001', 'UI-PERMI-001',
    'UI-DANGER-001', 'UI-IMAGE-001', 'UI-PAGE-001', 'UI-TOKEN-001', 'UI-UPLOAD-001',
    'UI-FORM-001', 'UI-DICT-001',
  ]) assert.ok(ruleIds.has(id), id);
  assert.deepEqual(new Set(receipt.obligations.map((item) => item.ruleId)), new Set([
    'UI-API-CONSUMER-001', 'UI-SHARED-CONSUMER-001', 'UI-STATE-001',
  ]));
});

test('modified legacy files are context-only and reuse requirements can fail closed', () => {
  const blockingContract = structuredClone(contract);
  blockingContract.reuseRequirements.apiAdapter.enforcement = 'block';
  blockingContract.reuseRequirements.sharedComponent.enforcement = 'block';
  const receipt = auditForgeUiContract({
    contract: blockingContract,
    files: [
      source('forge-admin-ui/src/views/business/legacy/index.vue', `
<template><div style="color: #f00"><n-pagination /></div></template>
<script>window.alert('legacy')</script>
`, 'modified'),
      source('forge-admin-ui/src/api/business/orphan.ts', "import request from '@/utils/request'\n"),
      source('forge-admin-ui/src/components/business/Unused.vue', '<template><div /></template>'),
    ],
  });
  const ids = new Set(receipt.findings.map((item) => item.ruleId));
  assert.deepEqual(ids, new Set(['UI-API-CONSUMER-001', 'UI-SHARED-CONSUMER-001']));
  assert.ok(!receipt.findings.some((item) => item.path.includes('/legacy/')));
  assert.equal(receipt.summary.addedBusinessFiles, 1);
});
