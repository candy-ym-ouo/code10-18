<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { createSHA256 } from "hash-wasm";
import { apiFetch, ApiError } from "../api/client.js";
import LoadingBlock from "../components/LoadingBlock.vue";
import {
  alertSeverityLabels,
  alertTypeLabels,
  formatBytes,
  formatDateTime,
  instrumentStatusLabels,
  maintenanceTypeLabels,
  repairStatusLabels,
} from "../utils/format.js";

type MaintenanceType = keyof typeof maintenanceTypeLabels;
interface Alert { type: keyof typeof alertTypeLabels; severity: keyof typeof alertSeverityLabels; message: string }
interface Maintenance { id: string; type: MaintenanceType; performedAt: string; stringBrand: string | null; cost: number | string | null; vendor: string | null; notes: string | null }
interface EnvironmentReading { id: string; temperatureC: number | string; humidityPct: number | string; recordedAt: string; source: string | null; note: string | null }
interface Repair { id: string; title: string; description: string | null; status: keyof typeof repairStatusLabels; dueDate: string | null; resolvedAt: string | null; version: number }
interface Attachment { id: string; originalName: string; mimeType: string; sizeBytes: number | string; status: string; createdAt: string }
interface Instrument {
  id: string; name: string; category: string; brand: string | null; model: string | null; serialNo: string | null;
  status: keyof typeof instrumentStatusLabels; version: number;
  stringChangedAt: string | null; stringMaxAgeDays: number;
  humidityMinPct: number | string | null; humidityMaxPct: number | string | null;
  temperatureMinC: number | string | null; temperatureMaxC: number | string | null;
  notes: string | null; mergedInto: { id: string; name: string } | null;
  mergedFrom: Array<{ id: string; name: string; mergedAt: string | null }>;
  maintenances: Maintenance[]; environments: EnvironmentReading[]; repairs: Repair[]; attachments: Attachment[];
}
interface InstrumentOption { id: string; name: string; category: string }

const route = useRoute();
const router = useRouter();
const instrumentId = route.params.id as string;

const instrument = ref<Instrument | null>(null);
const alerts = ref<Alert[]>([]);
const mergeCandidates = ref<InstrumentOption[]>([]);
const loading = ref(true);
const error = ref("");
const actionError = ref("");

const maintenanceForm = reactive({ type: "STRING_CHANGE" as MaintenanceType, performedAt: "", stringBrand: "", cost: "", vendor: "", notes: "" });
const environmentForm = reactive({ temperatureC: "", humidityPct: "", recordedAt: "", source: "手动记录", note: "" });
const repairForm = reactive({ title: "", description: "", dueDate: "" });
const editForm = reactive({ stringChangedAt: "", stringMaxAgeDays: 90, humidityMinPct: "", humidityMaxPct: "", temperatureMinC: "", temperatureMaxC: "", notes: "" });
const mergeTargetId = ref("");
const uploadProgress = ref<number | null>(null);

function toLocalInput(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fillEditForm(): void {
  if (!instrument.value) return;
  editForm.stringChangedAt = toLocalInput(instrument.value.stringChangedAt);
  editForm.stringMaxAgeDays = instrument.value.stringMaxAgeDays;
  editForm.humidityMinPct = instrument.value.humidityMinPct == null ? "" : String(instrument.value.humidityMinPct);
  editForm.humidityMaxPct = instrument.value.humidityMaxPct == null ? "" : String(instrument.value.humidityMaxPct);
  editForm.temperatureMinC = instrument.value.temperatureMinC == null ? "" : String(instrument.value.temperatureMinC);
  editForm.temperatureMaxC = instrument.value.temperatureMaxC == null ? "" : String(instrument.value.temperatureMaxC);
  editForm.notes = instrument.value.notes ?? "";
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [detail, candidates] = await Promise.all([
      apiFetch<{ instrument: Instrument; alerts: Alert[] }>(`/api/v1/instruments/${instrumentId}`),
      apiFetch<{ data: InstrumentOption[] }>("/api/v1/instruments?status=ACTIVE&limit=100"),
    ]);
    instrument.value = detail.instrument;
    alerts.value = detail.alerts;
    mergeCandidates.value = candidates.data.filter((item) => item.id !== instrumentId);
    fillEditForm();
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "设备加载失败";
  } finally {
    loading.value = false;
  }
}

async function run(action: () => Promise<void>): Promise<void> {
  actionError.value = "";
  try {
    await action();
    await load();
  } catch (reason) {
    actionError.value = reason instanceof ApiError ? reason.message : "操作失败，请重试";
  }
}

async function saveSettings(): Promise<void> {
  if (!instrument.value) return;
  await run(async () => {
    await apiFetch(`/api/v1/instruments/${instrumentId}`, {
      method: "PATCH",
      body: JSON.stringify({
        version: instrument.value!.version,
        stringChangedAt: editForm.stringChangedAt ? new Date(editForm.stringChangedAt).toISOString() : null,
        stringMaxAgeDays: Number(editForm.stringMaxAgeDays) || 90,
        humidityMinPct: editForm.humidityMinPct === "" ? null : Number(editForm.humidityMinPct),
        humidityMaxPct: editForm.humidityMaxPct === "" ? null : Number(editForm.humidityMaxPct),
        temperatureMinC: editForm.temperatureMinC === "" ? null : Number(editForm.temperatureMinC),
        temperatureMaxC: editForm.temperatureMaxC === "" ? null : Number(editForm.temperatureMaxC),
        notes: editForm.notes || null,
      }),
    });
  });
}

async function addMaintenance(): Promise<void> {
  await run(async () => {
    await apiFetch(`/api/v1/instruments/${instrumentId}/maintenances`, {
      method: "POST",
      body: JSON.stringify({
        type: maintenanceForm.type,
        performedAt: new Date(maintenanceForm.performedAt).toISOString(),
        stringBrand: maintenanceForm.stringBrand || null,
        cost: maintenanceForm.cost === "" ? null : Number(maintenanceForm.cost),
        vendor: maintenanceForm.vendor || null,
        notes: maintenanceForm.notes || null,
      }),
    });
    maintenanceForm.stringBrand = "";
    maintenanceForm.cost = "";
    maintenanceForm.vendor = "";
    maintenanceForm.notes = "";
  });
}

async function removeMaintenance(record: Maintenance): Promise<void> {
  if (!window.confirm("删除这条保养记录？")) return;
  await run(async () => {
    await apiFetch(`/api/v1/maintenances/${record.id}`, { method: "DELETE" });
  });
}

async function addEnvironment(): Promise<void> {
  await run(async () => {
    await apiFetch(`/api/v1/instruments/${instrumentId}/environments`, {
      method: "POST",
      body: JSON.stringify({
        temperatureC: Number(environmentForm.temperatureC),
        humidityPct: Number(environmentForm.humidityPct),
        recordedAt: new Date(environmentForm.recordedAt).toISOString(),
        source: environmentForm.source || null,
        note: environmentForm.note || null,
      }),
    });
    environmentForm.note = "";
  });
}

async function addRepair(): Promise<void> {
  await run(async () => {
    await apiFetch(`/api/v1/instruments/${instrumentId}/repairs`, {
      method: "POST",
      body: JSON.stringify({
        title: repairForm.title,
        description: repairForm.description || null,
        dueDate: repairForm.dueDate ? new Date(`${repairForm.dueDate}T12:00:00.000Z`).toISOString() : null,
      }),
    });
    repairForm.title = "";
    repairForm.description = "";
    repairForm.dueDate = "";
  });
}

async function completeRepair(repair: Repair): Promise<void> {
  await run(async () => {
    await apiFetch(`/api/v1/repairs/${repair.id}/complete`, { method: "POST", body: "{}" });
  });
}

async function sha256(file: File): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  const chunkSize = 4 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    hasher.update(new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer()));
  }
  return hasher.digest("hex");
}

function uploadPut(url: string, file: File, mimeType: string, digest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", mimeType);
    request.setRequestHeader("x-amz-meta-sha256", digest);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) uploadProgress.value = Math.round((event.loaded / event.total) * 100);
    };
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`对象存储返回 ${request.status}`)));
    request.onerror = () => reject(new Error("上传连接中断"));
    request.send(file);
  });
}

async function uploadAttachment(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  await run(async () => {
    uploadProgress.value = 0;
    const digest = await sha256(file);
    const mimeType = file.type || "application/octet-stream";
    const creation = await apiFetch<{ attachment: { id: string }; uploadUrl: string }>(
      `/api/v1/instruments/${instrumentId}/attachments/uploads`,
      { method: "POST", body: JSON.stringify({ originalName: file.name, mimeType, sizeBytes: file.size, sha256: digest }) },
    );
    await uploadPut(creation.uploadUrl, file, mimeType, digest);
    await apiFetch(`/api/v1/attachments/${creation.attachment.id}/complete-upload`, { method: "POST", body: "{}" });
    uploadProgress.value = null;
  });
  uploadProgress.value = null;
}

async function downloadAttachment(attachment: Attachment): Promise<void> {
  const result = await apiFetch<{ url: string }>(`/api/v1/attachments/${attachment.id}/download-url`);
  window.open(result.url, "_blank", "noopener");
}

async function removeAttachment(attachment: Attachment): Promise<void> {
  if (!window.confirm(`删除附件「${attachment.originalName}」？对象存储中的文件会先被清理。`)) return;
  await run(async () => {
    await apiFetch(`/api/v1/attachments/${attachment.id}`, { method: "DELETE" });
  });
}

async function mergeInstrument(): Promise<void> {
  const target = mergeCandidates.value.find((item) => item.id === mergeTargetId.value);
  if (!target) return;
  if (!window.confirm(`把「${instrument.value?.name}」的全部保养、环境、维修和附件历史归并到「${target.name}」？归并后本设备变为只读。`)) return;
  await run(async () => {
    await apiFetch(`/api/v1/instruments/${instrumentId}/merge`, { method: "POST", body: JSON.stringify({ targetId: mergeTargetId.value }) });
  });
}

async function deleteInstrument(): Promise<void> {
  if (!window.confirm(`删除设备「${instrument.value?.name}」？其附件对象会被后台清理，该操作不可撤销。`)) return;
  await run(async () => {
    await apiFetch(`/api/v1/instruments/${instrumentId}`, { method: "DELETE" });
    await router.push({ name: "instruments" });
  });
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
          <h1>{{ instrument.name }}</h1>
          <p>
          <span class="badge" :class="instrument.status">{{ instrumentStatusLabels[instrument.status] }}</span>
          {{ instrument.category }}<template v-if="instrument.brand"> · {{ instrument.brand }} {{ instrument.model ?? "" }}</template>
          <template v-if="instrument.mergedInto"> · 已归并到「{{ instrument.mergedInto.name }}」</template>
          </p>
        </div>
        <button class="button ghost" @click="router.push({ name: 'instruments' })">返回列表</button>
      </header>

      <div v-if="actionError" class="alert" style="margin-bottom: 16px">{{ actionError }}</div>

      <div v-if="alerts.length" class="alert-panel">
        <div v-for="alert in alerts" :key="alert.type" class="alert-item" :class="alert.severity">
          <strong>{{ alertSeverityLabels[alert.severity] }} · {{ alertTypeLabels[alert.type] }}</strong>
          <span>{{ alert.message }}</span>
        </div>
      </div>

      <div v-if="instrument.mergedFrom.length" class="alert info" style="margin-bottom: 16px">
        已并入设备：{{ instrument.mergedFrom.map((item) => item.name).join("、") }}，其历史记录已转移到本设备。
      </div>

      <div class="detail-grid">
        <section class="card stack">
          <h2>弦龄与环境阈值</h2>
          <form class="form-grid" @submit.prevent="saveSettings">
            <label class="field"><span>上次换弦时间</span><input v-model="editForm.stringChangedAt" type="datetime-local" :disabled="instrument.status !== 'ACTIVE'" /></label>
            <label class="field"><span>弦龄预警阈值（天）</span><input v-model="editForm.stringMaxAgeDays" type="number" min="7" max="730" :disabled="instrument.status !== 'ACTIVE'" /></label>
            <label class="field"><span>湿度下限（%）</span><input v-model="editForm.humidityMinPct" type="number" step="any" :disabled="instrument.status !== 'ACTIVE'" /></label>
            <label class="field"><span>湿度上限（%）</span><input v-model="editForm.humidityMaxPct" type="number" step="any" :disabled="instrument.status !== 'ACTIVE'" /></label>
            <label class="field"><span>温度下限（℃）</span><input v-model="editForm.temperatureMinC" type="number" step="any" :disabled="instrument.status !== 'ACTIVE'" /></label>
            <label class="field"><span>温度上限（℃）</span><input v-model="editForm.temperatureMaxC" type="number" step="any" :disabled="instrument.status !== 'ACTIVE'" /></label>
            <label class="field full"><span>备注</span><textarea v-model="editForm.notes" maxlength="2000" :disabled="instrument.status !== 'ACTIVE'" /></label>
            <div v-if="instrument.status === 'ACTIVE'" class="row end full"><button class="button" type="submit">保存设置</button></div>
          </form>
        </section>

        <section class="card stack">
          <h2>上报环境读数</h2>
          <form v-if="instrument.status === 'ACTIVE'" class="form-grid" @submit.prevent="addEnvironment">
            <label class="field"><span>温度（℃）</span><input v-model="environmentForm.temperatureC" required type="number" step="any" min="-40" max="60" /></label>
            <label class="field"><span>湿度（%）</span><input v-model="environmentForm.humidityPct" required type="number" step="any" min="0" max="100" /></label>
            <label class="field"><span>记录时间</span><input v-model="environmentForm.recordedAt" required type="datetime-local" /></label>
            <label class="field"><span>来源</span><input v-model="environmentForm.source" maxlength="60" /></label>
            <label class="field full"><span>备注</span><input v-model="environmentForm.note" maxlength="500" placeholder="同一时刻重复上报会覆盖旧读数，不会产生重复历史" /></label>
            <div class="row end full"><button class="button" type="submit">保存读数</button></div>
          </form>
          <div v-if="instrument.environments.length" class="record-list">
            <div v-for="reading in instrument.environments" :key="reading.id" class="record-row">
              <span>{{ reading.temperatureC }}℃ · {{ reading.humidityPct }}%</span>
              <small>{{ formatDateTime(reading.recordedAt) }}<template v-if="reading.source"> · {{ reading.source }}</template></small>
            </div>
          </div>
          <p v-else class="muted">还没有环境读数。</p>
        </section>

        <section class="card stack">
          <h2>保养记录</h2>
          <form v-if="instrument.status === 'ACTIVE'" class="form-grid" @submit.prevent="addMaintenance">
            <label class="field"><span>类型</span>
              <select v-model="maintenanceForm.type">
                <option v-for="(label, value) in maintenanceTypeLabels" :key="value" :value="value">{{ label }}</option>
              </select>
            </label>
            <label class="field"><span>保养时间</span><input v-model="maintenanceForm.performedAt" required type="datetime-local" /></label>
            <label v-if="maintenanceForm.type === 'STRING_CHANGE'" class="field"><span>琴弦型号</span><input v-model="maintenanceForm.stringBrand" maxlength="120" /></label>
            <label class="field"><span>费用（元）</span><input v-model="maintenanceForm.cost" type="number" step="any" min="0" /></label>
            <label class="field"><span>店家 / 技师</span><input v-model="maintenanceForm.vendor" maxlength="120" /></label>
            <label class="field full"><span>备注</span><textarea v-model="maintenanceForm.notes" maxlength="2000" placeholder="换弦记录会自动更新弦龄起点" /></label>
            <div class="row end full"><button class="button" type="submit">添加记录</button></div>
          </form>
          <div v-if="instrument.maintenances.length" class="record-list">
            <div v-for="record in instrument.maintenances" :key="record.id" class="record-row">
              <span>
                <span class="badge">{{ maintenanceTypeLabels[record.type] }}</span>
                {{ formatDateTime(record.performedAt) }}
                <template v-if="record.stringBrand"> · {{ record.stringBrand }}</template>
                <template v-if="record.cost != null"> · ¥{{ record.cost }}</template>
              </span>
              <span class="row">
                <small v-if="record.vendor">{{ record.vendor }}</small>
                <button v-if="instrument.status === 'ACTIVE'" class="button small ghost" @click="removeMaintenance(record)">删除</button>
              </span>
            </div>
          </div>
          <p v-else class="muted">还没有保养记录。</p>
        </section>

        <section class="card stack">
          <h2>维修事项</h2>
          <form v-if="instrument.status === 'ACTIVE'" class="form-grid" @submit.prevent="addRepair">
            <label class="field full"><span>事项</span><input v-model="repairForm.title" required maxlength="160" placeholder="例如：十二品打品需要调整" /></label>
            <label class="field"><span>期望完成日期</span><input v-model="repairForm.dueDate" type="date" /></label>
            <label class="field full"><span>问题描述</span><textarea v-model="repairForm.description" maxlength="2000" /></label>
            <div class="row end full"><button class="button" type="submit">添加事项</button></div>
          </form>
          <div v-if="instrument.repairs.length" class="record-list">
            <div v-for="repair in instrument.repairs" :key="repair.id" class="record-row">
              <span>
                <span class="badge" :class="repair.status">{{ repairStatusLabels[repair.status] }}</span>
                {{ repair.title }}
                <small v-if="repair.dueDate"> · 截止 {{ repair.dueDate.slice(0, 10) }}</small>
              </span>
              <button v-if="instrument.status === 'ACTIVE' && !['DONE', 'CANCELLED'].includes(repair.status)" class="button small" @click="completeRepair(repair)">完成</button>
            </div>
          </div>
          <p v-else class="muted">没有待处理的维修事项。</p>
        </section>

        <section class="card stack">
          <div class="row between">
            <h2>附件</h2>
            <label v-if="instrument.status === 'ACTIVE'" class="button small secondary" style="cursor: pointer">
              上传附件
              <input type="file" accept="image/*,application/pdf" style="display: none" @change="uploadAttachment" />
            </label>
          </div>
          <p v-if="uploadProgress != null" class="muted">上传中 {{ uploadProgress }}%</p>
          <div v-if="instrument.attachments.length" class="record-list">
            <div v-for="attachment in instrument.attachments" :key="attachment.id" class="record-row">
              <span>{{ attachment.originalName }} <small>{{ formatBytes(Number(attachment.sizeBytes)) }} · {{ attachment.status === "READY" ? "已校验" : "待上传" }}</small></span>
              <span class="row">
                <button v-if="attachment.status === 'READY'" class="button small ghost" @click="downloadAttachment(attachment)">查看</button>
                <button class="button small ghost" @click="removeAttachment(attachment)">删除</button>
              </span>
            </div>
          </div>
          <p v-else class="muted">还没有附件，可上传购买凭证、维修单据或照片。</p>
        </section>

        <section v-if="instrument.status === 'ACTIVE'" class="card stack danger-zone">
          <h2>设备操作</h2>
          <div class="stack">
            <div>
              <h3>归并到其他设备</h3>
              <p class="muted">把本设备的全部保养、环境、维修和附件历史转移到目标设备，避免重复设备造成历史分散。归并可安全重试，重复归并不会产生重复历史。</p>
              <div class="row">
                <select v-model="mergeTargetId" style="flex: 1">
                  <option value="" disabled>选择目标设备</option>
                  <option v-for="candidate in mergeCandidates" :key="candidate.id" :value="candidate.id">{{ candidate.name }}（{{ candidate.category }}）</option>
                </select>
                <button class="button secondary" :disabled="!mergeTargetId" @click="mergeInstrument">归并</button>
              </div>
            </div>
            <div>
              <h3>删除设备</h3>
              <p class="muted">删除后进入后台清理队列，附件对象会先被清理再删除记录，失败可重试。</p>
              <button class="button danger" @click="deleteInstrument">删除设备</button>
            </div>
          </div>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.alert-panel { display: grid; gap: 8px; margin-bottom: 16px; }
.alert-item { display: grid; gap: 2px; padding: 12px 14px; border-radius: 10px; background: var(--surface-soft); }
.alert-item.INFO { background: var(--surface-soft); color: #344540; }
.alert-item.WARNING { background: var(--warning-soft); color: #79430c; }
.alert-item.CRITICAL { background: var(--danger-soft); color: #71261f; }
.detail-grid { display: grid; gap: 17px; }
.record-list { display: grid; gap: 8px; }
.record-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px; background: var(--surface-soft); flex-wrap: wrap; }
.danger-zone h3 { margin: 0 0 6px; font-size: 1rem; }
</style>
