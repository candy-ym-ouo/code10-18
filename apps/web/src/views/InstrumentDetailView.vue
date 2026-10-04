<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import { apiFetch, ApiError } from "../api/client.js";
import LoadingBlock from "../components/LoadingBlock.vue";
import {
  formatBytes,
  formatDateTime,
  formatDecimal,
  instrumentStatusLabels,
  maintenanceAlertSeverityLabels,
  maintenanceAlertTypeLabels,
  maintenanceTaskStatusLabels,
  maintenanceTaskTypeLabels,
  toDateTimeLocal,
} from "../utils/format.js";

interface AlertItem { id: string; type: keyof typeof maintenanceAlertTypeLabels; severity: keyof typeof maintenanceAlertSeverityLabels; message: string }
interface StringChange { id: string; stringSet: string; changedAt: string; note: string | null }
interface EnvironmentReading { id: string; recordedAt: string; temperatureC: string | null; humidityPct: string | null; location: string | null; note: string | null }
interface Attachment { id: string; originalName: string; mimeType: string; sizeBytes: number; status: string }
interface Task {
  id: string; type: keyof typeof maintenanceTaskTypeLabels; title: string; description: string | null;
  status: keyof typeof maintenanceTaskStatusLabels; dueDate: string | null; cost: string | null; shop: string | null;
  version: number; attachments: Attachment[];
}
interface Instrument {
  id: string; name: string; category: string; brand: string | null; model: string | null; serialNo: string | null;
  status: keyof typeof instrumentStatusLabels; stringSet: string | null; stringLifespanDays: number;
  humidityMin: string; humidityMax: string; notes: string | null; version: number;
  stringChanges: StringChange[]; environmentReadings: EnvironmentReading[]; alerts: AlertItem[];
  mergedInto: { id: string; name: string } | null;
}
interface InstrumentOption { id: string; name: string; category: string; status: string }

const route = useRoute();
const instrumentId = route.params.id as string;
const instrument = ref<Instrument | null>(null);
const stringChanges = ref<StringChange[]>([]);
const readings = ref<EnvironmentReading[]>([]);
const tasks = ref<Task[]>([]);
const mergeCandidates = ref<InstrumentOption[]>([]);
const loading = ref(true);
const error = ref("");
const merging = ref(false);
const mergeTargetId = ref("");
const mergeResult = ref("");
const uploadProgress = reactive<Record<string, number>>({});

const stringForm = reactive({ stringSet: "", changedAt: toDateTimeLocal(), note: "" });
const envForm = reactive({ recordedAt: toDateTimeLocal(), temperatureC: "", humidityPct: "", location: "", note: "" });
const taskForm = reactive({ type: "SETUP" as keyof typeof maintenanceTaskTypeLabels, title: "", description: "", dueDate: "", cost: "", shop: "" });

const stringAgeDays = computed(() => {
  const last = instrument.value?.stringChanges[0];
  if (!last) return null;
  return Math.floor((Date.now() - new Date(last.changedAt).getTime()) / 86_400_000);
});
const stringAgeRatio = computed(() => {
  if (stringAgeDays.value == null || !instrument.value) return 0;
  return Math.min(1, stringAgeDays.value / instrument.value.stringLifespanDays);
});
const isActive = computed(() => instrument.value?.status === "ACTIVE");

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [detail, changeResult, readingResult, taskResult] = await Promise.all([
      apiFetch<{ instrument: Instrument }>(`/api/v1/instruments/${instrumentId}`),
      apiFetch<{ data: StringChange[] }>(`/api/v1/instruments/${instrumentId}/string-changes`),
      apiFetch<{ data: EnvironmentReading[] }>(`/api/v1/instruments/${instrumentId}/environment`),
      apiFetch<{ data: Task[] }>(`/api/v1/instruments/${instrumentId}/tasks?limit=100`),
    ]);
    instrument.value = detail.instrument;
    stringChanges.value = changeResult.data;
    readings.value = readingResult.data;
    tasks.value = taskResult.data;
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "设备详情加载失败";
  } finally {
    loading.value = false;
  }
}

async function addStringChange(): Promise<void> {
  await apiFetch(`/api/v1/instruments/${instrumentId}/string-changes`, {
    method: "POST",
    body: JSON.stringify({ stringSet: stringForm.stringSet, changedAt: new Date(stringForm.changedAt).toISOString(), note: stringForm.note || null }),
  });
  stringForm.stringSet = "";
  stringForm.note = "";
  await load();
}
async function addReading(): Promise<void> {
  await apiFetch(`/api/v1/instruments/${instrumentId}/environment`, {
    method: "POST",
    body: JSON.stringify({
      recordedAt: new Date(envForm.recordedAt).toISOString(),
      temperatureC: envForm.temperatureC === "" ? null : Number(envForm.temperatureC),
      humidityPct: envForm.humidityPct === "" ? null : Number(envForm.humidityPct),
      location: envForm.location || null,
      note: envForm.note || null,
    }),
  });
  envForm.temperatureC = "";
  envForm.humidityPct = "";
  await load();
}
async function addTask(): Promise<void> {
  await apiFetch(`/api/v1/instruments/${instrumentId}/tasks`, {
    method: "POST",
    body: JSON.stringify({
      type: taskForm.type,
      title: taskForm.title,
      description: taskForm.description || null,
      dueDate: taskForm.dueDate ? new Date(`${taskForm.dueDate}T12:00:00.000Z`).toISOString() : null,
      cost: taskForm.cost === "" ? null : Number(taskForm.cost),
      shop: taskForm.shop || null,
    }),
  });
  taskForm.title = "";
  taskForm.description = "";
  taskForm.dueDate = "";
  taskForm.cost = "";
  taskForm.shop = "";
  await load();
}
async function completeTask(task: Task): Promise<void> {
  await apiFetch(`/api/v1/maintenance-tasks/${task.id}/complete`, { method: "POST", body: "{}" });
  await load();
}
async function cancelTask(task: Task): Promise<void> {
  if (!window.confirm(`确认取消事项“${task.title}”？`)) return;
  await apiFetch(`/api/v1/maintenance-tasks/${task.id}/cancel`, { method: "POST", body: "{}" });
  await load();
}

async function uploadAttachment(task: Task, files: FileList | null): Promise<void> {
  if (!files?.length) return;
  for (const file of Array.from(files)) {
    uploadProgress[file.name] = 0;
    try {
      const digest = await sha256Hex(file);
      const mimeType = file.type || "application/octet-stream";
      const creation = await apiFetch<{ attachment: Attachment; uploadUrl: string }>(
        `/api/v1/maintenance-tasks/${task.id}/attachments/uploads`,
        { method: "POST", body: JSON.stringify({ originalName: file.name, mimeType, sizeBytes: file.size, sha256: digest }) },
      );
      await new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("PUT", creation.uploadUrl);
        request.setRequestHeader("Content-Type", mimeType);
        request.setRequestHeader("x-amz-meta-sha256", digest);
        request.upload.onprogress = (event) => {
          if (event.lengthComputable) uploadProgress[file.name] = Math.round((event.loaded / event.total) * 100);
        };
        request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`对象存储返回 ${request.status}`)));
        request.onerror = () => reject(new Error("上传连接中断"));
        request.send(file);
      });
      await apiFetch(`/api/v1/maintenance-attachments/${creation.attachment.id}/complete-upload`, { method: "POST", body: "{}" });
    } catch (reason) {
      error.value = reason instanceof ApiError ? reason.message : "附件上传失败";
    } finally {
      delete uploadProgress[file.name];
    }
  }
  await load();
}
async function downloadAttachment(attachment: Attachment): Promise<void> {
  const result = await apiFetch<{ url: string }>(`/api/v1/maintenance-attachments/${attachment.id}/download-url`);
  window.open(result.url, "_blank", "noopener");
}
async function removeAttachment(attachment: Attachment): Promise<void> {
  if (!window.confirm(`确认删除附件“${attachment.originalName}”？对象存储中的文件会一并清理。`)) return;
  await apiFetch(`/api/v1/maintenance-attachments/${attachment.id}`, { method: "DELETE" });
  await load();
}

async function openMerge(): Promise<void> {
  const result = await apiFetch<{ data: InstrumentOption[] }>("/api/v1/instruments?status=ACTIVE&limit=100");
  mergeCandidates.value = result.data.filter((item) => item.id !== instrumentId);
  mergeTargetId.value = mergeCandidates.value[0]?.id ?? "";
  mergeResult.value = "";
  merging.value = true;
}
async function confirmMerge(): Promise<void> {
  if (!mergeTargetId.value) return;
  const target = mergeCandidates.value.find((item) => item.id === mergeTargetId.value);
  if (!window.confirm(`确认把「${instrument.value?.name}」的全部保养历史归并到「${target?.name}」？重复记录会自动去重，此操作不可撤销。`)) return;
  const result = await apiFetch<{ moved: Record<string, number>; droppedDuplicates: Record<string, number> }>(
    `/api/v1/instruments/${instrumentId}/merge`,
    { method: "POST", body: JSON.stringify({ targetId: mergeTargetId.value }) },
  );
  mergeResult.value = `已转移：换弦 ${result.moved.stringChanges}、环境 ${result.moved.environmentReadings}、事项 ${result.moved.maintenanceTasks}；去除重复：换弦 ${result.droppedDuplicates.stringChanges}、环境 ${result.droppedDuplicates.environmentReadings}、事项 ${result.droppedDuplicates.maintenanceTasks}`;
  await load();
}
async function retire(): Promise<void> {
  if (!window.confirm("确认退役该设备？退役后不再参与预警扫描。")) return;
  await apiFetch(`/api/v1/instruments/${instrumentId}/retire`, { method: "POST", body: "{}" });
  await load();
}
async function reactivate(): Promise<void> {
  await apiFetch(`/api/v1/instruments/${instrumentId}/reactivate`, { method: "POST", body: "{}" });
  await load();
}
onMounted(load);
</script>

<template>
  <section class="page">
    <LoadingBlock v-if="loading" />
    <div v-else-if="error" class="alert">{{ error }} <button class="button small ghost" @click="load">重试</button></div>
    <template v-else-if="instrument">
      <header class="page-header">
        <div>
          <h1>{{ instrument.name }} <span class="badge" :class="instrument.status">{{ instrumentStatusLabels[instrument.status] }}</span></h1>
          <p>
            {{ instrument.category }}<template v-if="instrument.brand"> · {{ instrument.brand }}</template><template v-if="instrument.model"> {{ instrument.model }}</template>
            <template v-if="instrument.serialNo"> · 序列号 {{ instrument.serialNo }}</template>
          </p>
          <p v-if="instrument.mergedInto" class="muted">已归并到「{{ instrument.mergedInto.name }}」，历史记录随归并转移。</p>
        </div>
        <div class="row">
          <button v-if="isActive" class="button ghost" @click="openMerge">归并设备</button>
          <button v-if="isActive" class="button ghost" @click="retire">退役</button>
          <button v-if="instrument.status === 'RETIRED'" class="button secondary" @click="reactivate">重新启用</button>
        </div>
      </header>

      <div v-if="instrument.alerts.length" class="alert-list">
        <div v-for="alert in instrument.alerts" :key="alert.id" class="alert" :class="{ warning: alert.severity === 'WARNING', info: alert.severity === 'INFO' }">
          <span class="badge" :class="alert.severity">{{ maintenanceAlertSeverityLabels[alert.severity] }}</span>
          <span class="badge">{{ maintenanceAlertTypeLabels[alert.type] }}</span>
          <span>{{ alert.message }}</span>
        </div>
      </div>

      <div v-if="merging" class="card stack" style="margin-bottom: 18px">
        <h2>归并到其他设备</h2>
        <p class="muted">本设备的换弦、环境和维修历史将转移到目标设备；与目标设备完全重复的记录会被去除，重复事项的附件对象会先清理再删除。</p>
        <div class="row">
          <select v-model="mergeTargetId" style="flex: 1">
            <option v-for="candidate in mergeCandidates" :key="candidate.id" :value="candidate.id">{{ candidate.category }} · {{ candidate.name }}</option>
          </select>
          <button class="button" :disabled="!mergeTargetId" @click="confirmMerge">确认归并</button>
          <button class="button ghost" @click="merging = false">取消</button>
        </div>
        <p v-if="mergeResult" class="alert success">{{ mergeResult }}</p>
      </div>

      <div class="detail-grid">
        <section class="card stack">
          <h2>弦龄</h2>
          <div v-if="stringAgeDays != null" class="string-age">
            <div class="metric-line"><strong>{{ stringAgeDays }}</strong><span>/ {{ instrument.stringLifespanDays }} 天</span></div>
            <div class="progress-track"><div class="progress-fill" :class="{ overdue: stringAgeRatio >= 1 }" :style="{ width: `${Math.round(stringAgeRatio * 100)}%` }" /></div>
            <small class="muted">当前琴弦：{{ instrument.stringSet ?? "未设置" }} · 最近换弦 {{ formatDateTime(instrument.stringChanges[0]?.changedAt) }}</small>
          </div>
          <p v-else class="muted">尚未记录换弦，补录后开始跟踪弦龄。</p>
          <form v-if="isActive" class="stack" @submit.prevent="addStringChange">
            <div class="form-grid">
              <label class="field"><span>琴弦型号</span><input v-model="stringForm.stringSet" required maxlength="120" placeholder="如：Dominant 135B" /></label>
              <label class="field"><span>换弦时间</span><input v-model="stringForm.changedAt" required type="datetime-local" /></label>
              <label class="field full"><span>备注</span><input v-model="stringForm.note" maxlength="1000" /></label>
            </div>
            <div class="row end"><button class="button small" type="submit">记录换弦</button></div>
          </form>
          <div v-if="stringChanges.length" class="history">
            <div v-for="change in stringChanges" :key="change.id" class="history-row">
              <span>{{ change.stringSet }}</span><small>{{ formatDateTime(change.changedAt) }}</small>
            </div>
          </div>
        </section>

        <section class="card stack">
          <h2>环境</h2>
          <p class="muted">安全湿度 {{ formatDecimal(instrument.humidityMin) }}% – {{ formatDecimal(instrument.humidityMax) }}%，超出范围会触发预警。</p>
          <div v-if="readings[0]" class="metric-line">
            <strong>{{ formatDecimal(readings[0].humidityPct) }}%</strong><span>湿度</span>
            <strong>{{ formatDecimal(readings[0].temperatureC) }}℃</strong><span>温度</span>
            <small class="muted">{{ formatDateTime(readings[0].recordedAt) }}</small>
          </div>
          <p v-else class="muted">暂无环境记录。</p>
          <form v-if="isActive" class="stack" @submit.prevent="addReading">
            <div class="form-grid">
              <label class="field"><span>记录时间</span><input v-model="envForm.recordedAt" required type="datetime-local" /></label>
              <label class="field"><span>湿度（%）</span><input v-model="envForm.humidityPct" type="number" min="0" max="100" step="0.1" /></label>
              <label class="field"><span>温度（℃）</span><input v-model="envForm.temperatureC" type="number" min="-40" max="60" step="0.1" /></label>
              <label class="field"><span>存放位置</span><input v-model="envForm.location" maxlength="120" /></label>
            </div>
            <div class="row end"><button class="button small" type="submit">记录环境</button></div>
          </form>
          <div v-if="readings.length" class="history">
            <div v-for="reading in readings.slice(0, 8)" :key="reading.id" class="history-row">
              <span>湿度 {{ formatDecimal(reading.humidityPct) }}% · 温度 {{ formatDecimal(reading.temperatureC) }}℃<template v-if="reading.location"> · {{ reading.location }}</template></span>
              <small>{{ formatDateTime(reading.recordedAt) }}</small>
            </div>
          </div>
        </section>
      </div>

      <section class="card stack" style="margin-top: 17px">
        <h2>维修与保养事项</h2>
        <form v-if="isActive" class="stack" @submit.prevent="addTask">
          <div class="form-grid">
            <label class="field"><span>类型</span><select v-model="taskForm.type"><option v-for="(label, value) in maintenanceTaskTypeLabels" :key="value" :value="value">{{ label }}</option></select></label>
            <label class="field"><span>事项标题</span><input v-model="taskForm.title" required maxlength="160" placeholder="如：更换琴码、指板找平" /></label>
            <label class="field"><span>期望完成日期</span><input v-model="taskForm.dueDate" type="date" /></label>
            <label class="field"><span>费用（元）</span><input v-model="taskForm.cost" type="number" min="0" step="0.01" /></label>
            <label class="field"><span>维修店铺</span><input v-model="taskForm.shop" maxlength="120" /></label>
            <label class="field full"><span>详细描述</span><textarea v-model="taskForm.description" maxlength="3000" /></label>
          </div>
          <div class="row end"><button class="button small" type="submit">添加事项</button></div>
        </form>
        <p v-if="!tasks.length" class="muted">暂无事项。</p>
        <article v-for="task in tasks" :key="task.id" class="task-card">
          <div class="row between">
            <div>
              <span class="badge">{{ maintenanceTaskTypeLabels[task.type] }}</span>
              <span class="badge" :class="task.status">{{ maintenanceTaskStatusLabels[task.status] }}</span>
              <strong>{{ task.title }}</strong>
            </div>
            <div class="row">
              <small v-if="task.dueDate">截止 {{ task.dueDate.slice(0, 10) }}</small>
              <button v-if="!['DONE', 'CANCELLED'].includes(task.status)" class="button small" @click="completeTask(task)">完成</button>
              <button v-if="!['DONE', 'CANCELLED'].includes(task.status)" class="button small ghost" @click="cancelTask(task)">取消</button>
            </div>
          </div>
          <p v-if="task.description" class="muted">{{ task.description }}</p>
          <small class="muted">
            <template v-if="task.shop">店铺：{{ task.shop }} · </template>
            <template v-if="task.cost != null">费用：¥{{ formatDecimal(task.cost, 2) }}</template>
          </small>
          <div class="attachment-row">
            <span v-for="attachment in task.attachments" :key="attachment.id" class="attachment-chip">
              <a v-if="attachment.status === 'READY'" href="javascript:void 0" @click="downloadAttachment(attachment)">{{ attachment.originalName }}（{{ formatBytes(attachment.sizeBytes) }}）</a>
              <span v-else>{{ attachment.originalName }}（{{ attachment.status === "PENDING_UPLOAD" ? "待上传" : "上传失败" }}）</span>
              <button class="link-button" type="button" @click="removeAttachment(attachment)">删除</button>
            </span>
            <label v-if="isActive && !['DONE', 'CANCELLED'].includes(task.status)" class="button small ghost upload-label">
              上传附件
              <input type="file" accept="image/*,application/pdf" multiple hidden @change="uploadAttachment(task, ($event.target as HTMLInputElement).files); ($event.target as HTMLInputElement).value = ''" />
            </label>
            <small v-for="(value, name) in uploadProgress" :key="name" class="muted">{{ name }} {{ value }}%</small>
          </div>
        </article>
      </section>
    </template>
  </section>
</template>

<style scoped>
.alert-list { display: grid; gap: 8px; margin-bottom: 18px; }
.alert-list .alert { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 17px; }
.metric-line { display: flex; align-items: baseline; gap: 8px; }
.metric-line strong { font-size: 1.8rem; }
.metric-line span { color: var(--muted); }
.progress-track { height: 8px; border-radius: 999px; background: var(--surface-soft, #eceae4); overflow: hidden; }
.progress-fill { height: 100%; border-radius: 999px; background: #4d8a68; transition: width .3s; }
.progress-fill.overdue { background: #b0543f; }
.history { display: grid; gap: 6px; }
.history-row { display: flex; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: 8px; background: var(--surface-soft, #f2f0ea); }
.task-card { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--line, #e0dcd2); border-radius: 10px; }
.attachment-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.attachment-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 8px; background: var(--surface-soft, #f2f0ea); font-size: .85rem; }
.link-button { border: 0; background: none; color: #93372d; cursor: pointer; padding: 0; font-size: .82rem; }
.upload-label { cursor: pointer; }
@media (max-width: 900px) { .detail-grid { grid-template-columns: 1fr; } }
</style>
