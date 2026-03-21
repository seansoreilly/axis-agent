/**
 * Task Monitor — tracks active tasks and provides status via /task-status command
 * Enables `/loop` based monitoring of long-running agent tasks
 */

export interface ActiveTask {
  id: string;
  chatId: number;
  userId: number;
  startMs: number;
  messageId?: number;
  lastUpdateMs: number;
  status: "running" | "completed" | "failed";
  error?: string;
}

export interface TaskStatus {
  id: string;
  elapsedSeconds: number;
  elapsedText: string;
  isLongRunning: boolean;
  status: "running" | "completed" | "failed";
  error?: string;
  eta?: string;
  phase?: string;
}

export class TaskMonitor {
  private activeTasks = new Map<string, ActiveTask>();
  private readonly LONG_RUNNING_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Register a new task
   */
  registerTask(userId: number, chatId: number): string {
    const taskId = `task_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.activeTasks.set(taskId, {
      id: taskId,
      chatId,
      userId,
      startMs: Date.now(),
      lastUpdateMs: Date.now(),
      status: "running",
    });
    return taskId;
  }

  /**
   * Update task status
   */
  updateTask(taskId: string, status: "running" | "completed" | "failed", error?: string): void {
    const task = this.activeTasks.get(taskId);
    if (!task) return;

    task.status = status;
    task.lastUpdateMs = Date.now();
    if (error) task.error = error;

    // Clean up completed tasks after 5 minutes
    if (status === "completed" || status === "failed") {
      setTimeout(() => this.activeTasks.delete(taskId), 5 * 60 * 1000);
    }
  }

  /**
   * Set message ID for editable status updates
   */
  setMessageId(taskId: string, messageId: number): void {
    const task = this.activeTasks.get(taskId);
    if (task) task.messageId = messageId;
  }

  /**
   * Get task status for monitoring
   */
  getStatus(taskId: string, etaProvider?: () => string): TaskStatus | null {
    const task = this.activeTasks.get(taskId);
    if (!task) return null;

    const elapsedMs = Date.now() - task.startMs;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const elapsedText = this.formatElapsed(elapsedSeconds);
    const isLongRunning = elapsedMs >= this.LONG_RUNNING_THRESHOLD_MS;

    return {
      id: taskId,
      elapsedSeconds,
      elapsedText,
      isLongRunning,
      status: task.status,
      error: task.error,
      eta: etaProvider?.(),
      phase: undefined, // Can be enhanced later with phase tracking
    };
  }

  /**
   * Get all active tasks for a user
   */
  getActiveTasks(userId: number): TaskStatus[] {
    return Array.from(this.activeTasks.values())
      .filter((t) => t.userId === userId && t.status === "running")
      .map((t) => ({
        id: t.id,
        elapsedSeconds: Math.floor((Date.now() - t.startMs) / 1000),
        elapsedText: this.formatElapsed(Math.floor((Date.now() - t.startMs) / 1000)),
        isLongRunning: Date.now() - t.startMs >= this.LONG_RUNNING_THRESHOLD_MS,
        status: t.status,
        error: t.error,
      }));
  }

  /**
   * Format elapsed time as "Xm Ys"
   */
  private formatElapsed(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) {
      return `${mins}m ${secs}s`;
    }
    return `${secs}s`;
  }
}
