<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { apiFetch, ApiError } from "../api/client.js";
import EmptyState from "../components/EmptyState.vue";
import LoadingBlock from "../components/LoadingBlock.vue";
import { alertSeverityLabels, alertTypeLabels, instrumentStatusLabels } from "../utils/format.js";

interface InstrumentAlert {
  id: string;
  type: keyof typeof alertTypeLabels;
  severity: keyof typeof alertSeverityLabels;
  message: string;
}
interface Instrument {
  id: string;
  name: string;
  category: string;
  brand: string | null;
  model: string | null;
  status: keyof typeof instrumentStatusLabels;
  stringChangedAt: string | null;
  stringMaxAgeDays: number;
  mergedInto: { id: string; name: string } | null;
  alerts: InstrumentAlert[];
  _count: { maintenances: number; repairs: number; environments: number; attachments: number };
}

const instruments = ref<Instrument[]>([]);
const status = ref("ACTIVE");
const loading = ref(true);
const error = ref("");
const creating = ref(false);
const form = reactive({
  name: "",
  category: "",
  brand: "",
  model: "",
  stringChangedAt: "",
  stringMaxAgeDays: 90,
  humidityMinPct: "40",
  humidityMaxPct: "60",
  notes: "",
});

function stringAgeDays(instrument: Instrument): number | null {
  if (!instrument.stringChangedAt) return null;
  return Math.floor((Date.now() - new Date(instrument.stringChangedAt).getTime()) / 86_400_000);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const result = await apiFetch<{ data: Instrument[] }>(`/api/v1/instruments?status=${status.value}&limit=100`);
    instruments.value = result.data;
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "设备加载失败";
  } finally {
    loading.value = false;
  }
}

async function createInstrument(): Promise<void> {
  await apiFetch("/api/v1/instruments", {
    method: "POST",
    body: JSON.stringify({
      name: form.name,
      category: form.category,
      brand: form.brand || null,
      model: form.model || null,
      stringChangedAt: form.stringChangedAt ? new Date(`${form.stringChangedAt}T12:00:00.000Z`).toISOString() : null,
      stringMaxAgeDays: Number(form.stringMaxAgeDays) || 90,
      humidityMinPct: form.humidityMinPct === "" ? null : Number(form.humidityMinPct),
      humidityMaxPct: form.humidityMaxPct === "" ? null : Number(form.humidityMaxPct),
      notes: form.notes || null,
    }),
  });
  creating.value = false;
  form.name = "";
  form.category = "";
  form.brand = "";
  form.model = "";
  form.stringChangedAt = "";
  form.notes = "";
  await load();
}

onMounted(load);
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div><h1>乐器保养</h1><p>登记设备，跟踪弦龄、存放环境与维修事项，异常自动预警。</p></div>
      <button class="button" @click="creating = !creating">登记设备</button>
    </header>
    <div class="tabs" style="margin-bottom: 18px">
      <button class="tab" :class="{ active: status === 'ACTIVE' }" @click="status = 'ACTIVE'; load()">在用</button>
      <button class="tab" :class="{ active: status === 'MERGED' }" @click="status = 'MERGED'; load()">已归并</button>
      <button class="tab" :class="{ active: status === 'RETIRED' }" @click="status = 'RETIRED'; load()">已退役</button>
      <button class="tab" :class="{ active: status === 'ALL' }" @click="status = 'ALL'; load()">全部</button>
    </div>

    <form v-if="creating" class="card form-grid" style="margin-bottom: 18px" @submit.prevent="createInstrument">
      <label class="field"><span>设备名称</span><input v-model="form.name" required maxlength="80" placeholder="例如：主力民谣吉他" /></label>
      <label class="field"><span>乐器类别</span><input v-model="form.category" required maxlength="60" placeholder="吉他 / 小提琴 / 钢琴…" /></label>
      <label class="field"><span>品牌</span><input v-model="form.brand" maxlength="80" /></label>
      <label class="field"><span>型号</span><input v-model="form.model" maxlength="80" /></label>
      <label class="field"><span>上次换弦日期</span><input v-model="form.stringChangedAt" type="date" /></label>
      <label class="field"><span>弦龄预警阈值（天）</span><input v-model="form.stringMaxAgeDays" type="number" min="7" max="730" /></label>
      <label class="field"><span>湿度下限（%）</span><input v-model="form.humidityMinPct" type="number" step="any" min="0" max="100" /></label>
      <label class="field"><span>湿度上限（%）</span><input v-model="form.humidityMaxPct" type="number" step="any" min="0" max="100" /></label>
      <label class="field full"><span>备注</span><textarea v-model="form.notes" maxlength="2000" /></label>
      <div class="row end full"><button class="button ghost" type="button" @click="creating = false">取消</button><button class="button" type="submit">保存设备</button></div>
    </form>

    <LoadingBlock v-if="loading" />
    <div v-else-if="error" class="alert">{{ error }} <button class="button small ghost" @click="load">重试</button></div>
    <EmptyState v-else-if="!instruments.length" title="还没有乐器设备" description="登记你的乐器，开始跟踪弦龄、存放环境和维修事项。" action-label="登记设备" @action="creating = true" />
    <div v-else class="instruments-grid">
      <article v-for="instrument in instruments" :key="instrument.id" class="card stack instrument-card" @click="$router.push(`/instruments/${instrument.id}`)">
        <div class="row between">
          <span class="badge" :class="instrument.status">{{ instrumentStatusLabels[instrument.status] }}</span>
          <small v-if="instrument.stringChangedAt">弦龄 {{ stringAgeDays(instrument) }} 天 / 阈值 {{ instrument.stringMaxAgeDays }} 天</small>
          <small v-else>未记录换弦</small>
        </div>
        <div>
          <h2>{{ instrument.name }}</h2>
          <p class="muted">{{ instrument.category }}<template v-if="instrument.brand"> · {{ instrument.brand }} {{ instrument.model ?? "" }}</template></p>
        </div>
        <p v-if="instrument.mergedInto" class="muted">已归并到「{{ instrument.mergedInto.name }}」，历史记录随归并转移。</p>
        <div v-if="instrument.alerts.length" class="alert-list">
          <div v-for="alert in instrument.alerts" :key="alert.id" class="alert-item" :class="alert.severity">
            <strong>{{ alertSeverityLabels[alert.severity] }} · {{ alertTypeLabels[alert.type] }}</strong>
            <span>{{ alert.message }}</span>
          </div>
        </div>
        <div class="row wrap">
          <small class="muted">保养 {{ instrument._count.maintenances }}</small>
          <small class="muted">环境 {{ instrument._count.environments }}</small>
          <small class="muted">维修 {{ instrument._count.repairs }}</small>
          <small class="muted">附件 {{ instrument._count.attachments }}</small>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.instruments-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 17px; }
.instrument-card { cursor: pointer; }
.alert-list { display: grid; gap: 8px; }
.alert-item { display: grid; gap: 2px; padding: 10px 12px; border-radius: 10px; font-size: .88rem; background: var(--surface-soft); }
.alert-item.WARNING { background: var(--warning-soft); color: #79430c; }
.alert-item.CRITICAL { background: var(--danger-soft); color: #71261f; }
@media (max-width: 900px) { .instruments-grid { grid-template-columns: 1fr; } }
</style>
