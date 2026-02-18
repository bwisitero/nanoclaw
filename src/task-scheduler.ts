import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { ContainerOutput, runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { QuietHours, RegisteredGroup, ScheduledTask } from './types.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // Idle timer: writes _close sentinel after IDLE_TIMEOUT of no output,
  // so the container exits instead of hanging at waitForIpcMessage forever.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Scheduled task idle timeout, closing container stdin');
      deps.queue.closeStdin(task.chat_jid);
    }, IDLE_TIMEOUT);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
      },
      (proc, containerName) => deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          // Only reset idle timer on actual results, not session-update markers
          resetIdleTimer();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (idleTimer) clearTimeout(idleTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

/**
 * Check if the current time falls within a task's quiet hours window.
 * Quiet hours suppress task execution during sleep/off hours.
 * The window can wrap past midnight (e.g. 22:00 → 07:00).
 */
export function isInQuietHours(task: ScheduledTask): boolean {
  if (!task.quiet_hours) return false;

  let qh: QuietHours;
  try {
    qh = JSON.parse(task.quiet_hours);
  } catch {
    return false;
  }

  if (!qh.start || !qh.end) return false;

  // Get current time in the configured timezone
  const now = new Date();
  const localTime = new Date(now.toLocaleString('en-US', { timeZone: TIMEZONE }));
  return isTimeInQuietWindow(qh, localTime.getHours() * 60 + localTime.getMinutes(), localTime.getDay());
}

/**
 * Advance a task's next_run past the quiet hours window.
 * For cron tasks, finds the next cron match outside the window.
 * For interval tasks, adds intervals until outside the window.
 */
/**
 * Check if a given time (in minutes-of-day + day-of-week) falls within a quiet window.
 * Extracted to avoid duplicating the overnight-wrap logic.
 */
function isTimeInQuietWindow(qh: QuietHours, minutesOfDay: number, dayOfWeek: number): boolean {
  const [startH, startM] = qh.start.split(':').map(Number);
  const [endH, endM] = qh.end.split(':').map(Number);
  const startMins = startH * 60 + startM;
  const endMins = endH * 60 + endM;

  const dayMatch = !qh.days || qh.days.length === 0 || qh.days.includes(dayOfWeek);
  if (!dayMatch) return false;

  if (startMins <= endMins) {
    return minutesOfDay >= startMins && minutesOfDay < endMins;
  } else {
    // Overnight window (e.g. 22:00 → 07:00)
    return minutesOfDay >= startMins || minutesOfDay < endMins;
  }
}

/**
 * Advance a task's next_run past the quiet hours window.
 * Returns null if the task should just wait (once tasks, or exhausted attempts).
 * For cron/interval tasks, tries up to 1500 candidates (~24h for every-minute cron).
 * If all candidates are inside quiet hours, returns null — the task will be
 * re-evaluated each scheduler tick until quiet hours end naturally.
 */
function advancePastQuietHours(task: ScheduledTask): string | null {
  let qh: QuietHours;
  try { qh = JSON.parse(task.quiet_hours!); } catch { return null; }
  if (!qh.start || !qh.end) return null;

  if (task.schedule_type === 'cron') {
    // Try up to 1500 cron matches (~24h for every-minute tasks)
    const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
    for (let i = 0; i < 1500; i++) {
      const next = interval.next();
      const nextIso = next.toISOString();
      if (!nextIso) continue;
      const candidateLocal = new Date(new Date(nextIso).toLocaleString('en-US', { timeZone: TIMEZONE }));
      if (!isTimeInQuietWindow(qh, candidateLocal.getHours() * 60 + candidateLocal.getMinutes(), candidateLocal.getDay())) {
        return nextIso;
      }
    }
    // Could not find a match outside quiet hours — let the scheduler re-check next tick
    logger.warn({ taskId: task.id }, 'Could not advance past quiet hours (1500 cron iterations exhausted)');
    return null;
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    let candidate = Date.now() + ms;
    for (let i = 0; i < 1500; i++) {
      const candidateLocal = new Date(new Date(candidate).toLocaleString('en-US', { timeZone: TIMEZONE }));
      if (!isTimeInQuietWindow(qh, candidateLocal.getHours() * 60 + candidateLocal.getMinutes(), candidateLocal.getDay())) {
        return new Date(candidate).toISOString();
      }
      candidate += ms;
    }
    logger.warn({ taskId: task.id }, 'Could not advance past quiet hours (1500 interval iterations exhausted)');
    return null;
  }

  // 'once' tasks: return null — they'll wait until quiet hours end naturally
  return null;
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Quiet hours: skip and reschedule if task is in a suppression window.
        // The task stays active but its next_run is advanced past the window.
        if (isInQuietHours(currentTask)) {
          const newNextRun = advancePastQuietHours(currentTask);
          if (newNextRun) {
            updateTask(currentTask.id, { next_run: newNextRun });
            logger.info(
              { taskId: currentTask.id, nextRun: newNextRun },
              'Task deferred (quiet hours)',
            );
          }
          continue;
        }

        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          () => runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
