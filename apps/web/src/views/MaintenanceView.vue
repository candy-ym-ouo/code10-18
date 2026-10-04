<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { apiFetch, ApiError } from "../api/client.js";
import EmptyState from "../components/EmptyState.vue";
import LoadingBlock from "../components/LoadingBlock.vue";
import {
  formatDateTime,
  formatDecimal,
  instrumentStatusLabels,
  maintenanceAlertSeverityLabels,
  maintenanceAlertTypeLabels,
} from "../utils/format.js";

interface InstrumentSummary {
  id: string; name: string; category: string; brand: string | null; model: string | null;
  status: keyof typeof instrumentStatusLabels; stringSet: string | null; stringLifespanDays: number;
  stringChanges: Array<{ changedAt: string; stringSet: string }>;
  environmentReadings: Array<{ recordedAt: string; humidityPct: string | null; temperatureC: string | null }>;
  _count: { alerts: number; maintenanceTasks: number };
}
interface AlertItem {
  id: string; type: keyof typeof maintenanceAlertTypeLabels; severity: keyof typeof maintenanceAlertSeverityLabels;
  message: string; detectedAt: string; instrument: { id: string; name: string };
}

const instruments = ref<InstrumentSummary[]>([]);
const alerts = ref<AlertItem[]>([]);
const loading = ref(true);
const error = ref("");
const creating = ref(false);
const scanning = ref(false);
const form = reactive({
  name: "", category: "", brand: "", model: "", serialNo: "", stringSet: "",
  stringLifespanDays: 90, humidityMin: 40, humidityMax: 60, notes: "",
});

function stringAgeDays(instrument: InstrumentSummary): number | null {
  const last = instrument.stringChanges[0];
  if (!last) return null;
  return Math.floor((Date.now() - new Date(last.changedAt).getTime()) / 86_400_000);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [instrumentResult, alertResult] = await Promise.all([
      apiFetch<{ data: InstrumentSummary[] }>("/api/v1/instruments?status=ALL&limit=100"),
      apiFetch<{ data: AlertItem[] }>("/api/v1/maintenance/alerts?status=ACTIVE"),
    ]);
    instruments.value = instrumentResult.data;
    alerts.value = alertResult.data;
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "设备保养数据加载失败";
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
      serialNo: form.serialNo || null,
      stringSet: form.stringSet || null,
      stringLifespanDays: Number(form.stringLifespanDays),
      humidityMin: Number(form.humidityMin),
      humidityMax: Number(form.humidityMax),
      notes: form.notes || null,
    }),
  });
  creating.value = false;
  form.name = "";
  form.category = "";
  await load();
}
async function resolveAlert(alert: AlertItem): Promise<void> {
  await apiFetch(`/api/v1/maintenance/alerts/${alert.id}/resolve`, { method: "POST", body: "{}" });
  await load();
}
async function runScan(): Promise<void> {
  scanning.value = true;
  try {
    await apiFetch("/api/v1/maintenance/scan", { method: "POST", body: "{}" });
    // 扫描在后台执行，稍等片刻后刷新快照
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await load();
  } finally {
    scanning.value = false;
  }
}
onMounted(load);
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div><h1>设备保养</h1><p>跟踪每件乐器的弦龄、存放环境与维修事项，异常自动预警。</p></div>
      <div class="row">
        <button class="button ghost" :disabled="scanning" @click="runScan">{{ scanning ? "扫描中…" : "立即扫描" }}</button>
        <button class="button" @click="creating = !creating">登记设备</button>
      </div>
    </header>

    <div v-if="alerts.length" class="alert-list">
      <div v-for="alert in alerts" :key="alert.id" class="alert" :class="{ warning: alert.severity === 'WARNING', info: alert.severity === 'INFO' }">
        <span class="badge" :class="alert.severity">{{ maintenanceAlertSeverityLabels[alert.severity] }}</span>
        <span class="badge">{{ maintenanceAlertTypeLabels[alert.type] }}</span>
        <strong>{{ alert.instrument.name }}</strong>
        <span>{{ alert.message }}</span>
        <small>{{ formatDateTime(alert.detectedAt) }}</small>
        <button class="button small ghost" @click="resolveAlert(alert)">知道了</button>
      </div>
    </div>

    <form v-if="creating" class="card form-grid" style="margin-bottom: 18px" @submit.prevent="createInstrument">
      <label class="field"><span>设备名称</span><input v-model="form.name" required maxlength="80" placeholder="如：演出用小提琴" /></label>
      <label class="field"><span>乐器类别</span><input v-model="form.category" required maxlength="60" placeholder="如：小提琴" /></label>
      <label class="field"><span>品牌</span><input v-model="form.brand" maxlength="80" /></label>
      <label class="field"><span>型号</span><input v-model="form.model" maxlength="80" /></label>
      <label class="field"><span>序列号</span><input v-model="form.serialNo" maxlength="80" /></label>
      <label class="field"><span>当前琴弦</span><input v-model="form.stringSet" maxlength="120" placeholder="如：Dominant 135B" /></label>
      <label class="field"><span>琴弦寿命（天）</span><input v-model="form.stringLifespanDays" type="number" min="7" max="730" required /></label>
      <label class="field"><span>湿度下限（%）</span><input v-model="form.humidityMin" type="number" min="0" max="100" required /></label>
      <label class="field"><span>湿度上限（%）</span><input v-model="form.humidityMax" type="number" min="0" max="100" required /></label>
      <label class="field full"><span>备注</span><textarea v-model="form.notes" maxlength="2000" /></label>
      <div class="row end full"><button class="button ghost" type="button" @click="creating = false">取消</button><button class="button" type="submit">登记设备</button></div>
    </form>

    <LoadingBlock v-if="loading" />
    <div v-else-if="error" class="alert">{{ error }} <button class="button small ghost" @click="load">重试</button></div>
    <EmptyState v-else-if="!instruments.length" title="还没有登记设备" description="登记乐器后即可记录换弦、环境和维修事项，系统会自动预警。" action-label="登记设备" @action="creating = true" />
    <div v-else class="instrument-grid">
      <article v-for="instrument in instruments" :key="instrument.id" class="card stack instrument-card" @click="$router.push(`/maintenance/${instrument.id}`)">
        <div class="row between">
          <span class="badge" :class="instrument.status">{{ instrumentStatusLabels[instrument.status] }}</span>
          <small v-if="instrument._count.alerts > 0" class="alert-count">{{ instrument._count.alerts }} 条预警</small>
        </div>
        <div>
          <h2>{{ instrument.name }}</h2>
          <p class="muted">{{ instrument.category }}<template v-if="instrument.brand"> · {{ instrument.brand }}</template><template v-if="instrument.model"> {{ instrument.model }}</template></p>
        </div>
        <div class="metric-line">
          <template v-if="stringAgeDays(instrument) != null">
            <strong>{{ stringAgeDays(instrument) }}</strong><span>天弦龄 / 寿命 {{ instrument.stringLifespanDays }} 天</span>
          </template>
          <template v-else><span class="muted">未记录换弦</span></template>
        </div>
        <div class="row between">
          <small v-if="instrument.environmentReadings[0]" class="muted">
            湿度 {{ formatDecimal(instrument.environmentReadings[0].humidityPct) }}% · 温度 {{ formatDecimal(instrument.environmentReadings[0].temperatureC) }}℃
          </small>
          <small v-else class="muted">暂无环境记录</small>
          <small v-if="instrument._count.maintenanceTasks > 0">{{ instrument._count.maintenanceTasks }} 项待办</small>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.alert-list { display: grid; gap: 8px; margin-bottom: 18px; }
.alert-list .alert { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.alert-list .alert small { color: inherit; opacity: .7; }
.instrument-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 17px; }
.instrument-card { cursor: pointer; }
.metric-line { display: flex; align-items: baseline; gap: 8px; }
.metric-line strong { font-size: 1.8rem; }
.metric-line span { color: var(--muted); }
.alert-count { color: var(--danger, #93372d); font-weight: 700; }
@media (max-width: 900px) { .instrument-grid { grid-template-columns: 1fr; } }
</style>
