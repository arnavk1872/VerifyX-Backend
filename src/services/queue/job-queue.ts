type JobHandler = (data: any) => Promise<void>;

interface Job {
  id: string;
  type: string;
  data: any;
  attempts: number;
  maxAttempts: number;
}

class JobQueue {
  private queue: Job[] = [];
  private handlers: Map<string, JobHandler> = new Map();
  private processing = false;
  private maxConcurrent = 3;
  private activeJobs = 0;

  async add(type: string, data: any, maxAttempts: number = 3): Promise<string> {
    const job: Job = {
      id: `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      data,
      attempts: 0,
      maxAttempts,
    };

    this.queue.push(job);
    this.process();
    
    return job.id;
  }

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  private async process(): Promise<void> {
    if (this.processing || this.activeJobs >= this.maxConcurrent) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0 && this.activeJobs < this.maxConcurrent) {
      const job = this.queue.shift();
      if (!job) break;

      this.activeJobs++;
      this.processJob(job).finally(() => {
        this.activeJobs--;
        if (this.queue.length > 0) {
          this.process();
        } else {
          this.processing = false;
        }
      });
    }

    if (this.queue.length === 0) {
      this.processing = false;
    }
  }

  private async processJob(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    
    if (!handler) {
      console.error(`[JobQueue] No handler registered for job type: ${job.type}`);
      return;
    }
    
    try {
      job.attempts++;
      await handler(job.data);
    } catch (error: any) {
      if (job.attempts < job.maxAttempts) {
        const retryDelay = Math.pow(2, job.attempts) * 1000;
        setTimeout(() => {
          this.queue.push(job);
          this.process();
        }, retryDelay);
      }
      throw error;
    }
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getActiveJobs(): number {
    return this.activeJobs;
  }
}

export const jobQueue = new JobQueue();

