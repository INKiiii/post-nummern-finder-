export type Scores = { hook: number; payoff: number; clarity: number; emotion: number; meme: number; risk: number }

export interface Stream {
  id: number; channel_id: number | null; source_type: string; title: string; game: string; status: string
  started_at: string | null; ended_at: string | null; duration: number; gaps: { at: number; seconds: number; reason: string }[]
  cost_estimate_usd: number | null; cost_actual_usd: number; live_mode: boolean; post_mode: boolean; error: string | null
  selection: Record<string, unknown> | null; counts: Record<string, number>; channel: string | null; ads: number; reconnects: number
  jobs?: Job[]
}

export interface Channel {
  id: number; login: string; display_name: string; profile_image_url: string | null; status: string
  live_enabled: boolean; post_enabled: boolean; clips_per_stream: number; min_score: number; language: string; brand_voice: string
  create_twitch_clips: boolean; chat_clip_command: boolean; vod_backup: boolean; layout: string
  facecam_rect: { x: number; y: number; w: number; h: number } | null
  consent_confirmed: boolean; streamer_authorized: boolean; last_error: string | null
  current_stream: Stream | null; live_clips: number; pending_review: number
}

export interface Publication {
  id: number; clip_id: number; account_id: number; platform: string; status: string; position: number
  scheduled_at: string | null; attempts: number; error: string | null; external_url: string | null; published_at: string | null
  metrics: Record<string, number>; account_name: string
  clip?: { id: number; title: string; total_score: number; duration: number; thumb_url: string | null }
}

export interface Captions {
  tiktok?: { description: string; hashtags: string[] }
  instagram?: { caption: string; hashtags: string[] }
  youtube?: { title: string; description: string; tags: string[] }
}

export interface Clip {
  id: number; stream_id: number; origin: string; review_state: string; bucket: string; rank: number | null
  start: number; end: number; duration: number; title: string; hook_text: string; context_line: string; category: string
  reason: string; scores: Scores; total_score: number; safety_flagged: boolean; safety_override: boolean
  safety_flags: string[]; safety_labels: string[]; safety_note: string; live_confirmed: boolean
  render_status: string; render_error: string | null; has_preview: boolean; has_final: boolean; version: number
  preview_url: string | null; thumb_url: string | null; final_url: string | null; platforms: number[]
  created_at: string; channel: string; publications: { platform: string; status: string }[] | Publication[]
  transcript?: string; words?: { text: string; start: number; end: number }[]; cuts?: number[][]
  subtitle_lines?: string[]; captions?: Captions; stream_duration?: number | null; slug?: string
  signals?: { signals: { type: string; t: number; strength: number; detail: string }[] }
}

export interface Job {
  id: number; type: string; status: string; progress: number; progress_msg: string; step: string; attempts: number
  max_attempts: number; error: string | null; stream_id: number | null; clip_id: number | null; created_at: string
  finished_at: string | null
}

export interface Quota { account_id: number; platform: string; name: string; used: number; cap: number; left: number; note: string; units_used: number; units_total: number | null }

export interface Account {
  id: number; platform: string; name: string; owner: string; status: string; daily_limit: number; api_approved: boolean
  post_mode: string; privacy: string; windows: string[][] | null; min_gap_minutes: number; jitter_minutes: number
  enabled: boolean; last_error: string | null; quota: Quota | null
}

export interface Status {
  twitch_app: boolean; twitch_mod: { login: string; scopes: string[] } | null; ai: string; model: string; whisper: boolean
  disk: { free_gb: number; total_gb: number; free_percent: number; warn: boolean; critical: boolean; data_gb: number }
  jobs: Record<string, number>; pending_review: number; warnings: string[]; public_url: string; fake: boolean
}
