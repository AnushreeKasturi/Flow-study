export type TimerMode = 'focus' | 'shortBreak' | 'longBreak';
export type AudioProvider = 'youtube' | 'spotify';
export type Durations = Record<TimerMode, number>;
export interface TimerState {
    mode: TimerMode; timeLeft: number; isRunning: boolean; duration: number;
    sessionCount: number; durations: Durations;
}
export interface Task {
    id: string; room_id: string; title: string; completed: boolean;
    created_by: string | null; assigned_to?: string | null; created_at?: string;
    pending?: boolean;
}
export interface TaskStats { total: number; completed: number; }
export interface PresenceState {
    status: string; nowPlaying?: string | null; currentTask?: string; focusTime?: number;
}
export interface Participant {
    userId?: string; username?: string; status?: string; nowPlaying?: string | null;
    isDummyMedia?: boolean; handRaised?: boolean; presence?: PresenceState;
}
export type Participants = Record<string, Participant>;
export interface ChatMessage { sender: string; text: string; }
export type Signal =
    | { type: 'offer'; offer: RTCSessionDescriptionInit }
    | { type: 'answer'; answer: RTCSessionDescriptionInit }
    | { type: 'candidate'; candidate: RTCIceCandidateInit | null };
export interface SignalMessage { from: string; to?: string; signal: Signal; }
export type RemoteStream = (userId: string, stream: MediaStream) => void;
export interface SocketHandlers {
    onConnectionStatus?: (status: string) => void;
    onRoomState: (state: { participants: Participants }) => void;
    onUserJoined: (participant: Participant & { userId: string }) => void;
    onUserLeft: (userId: string) => void;
    onPresenceHeartbeat?: (participant: Participant & { userId: string }) => void;
    onSignal: (message: SignalMessage) => void;
    onTimerUpdated: (state: Partial<TimerState>) => void;
    onTasksError?: () => void;
    onRoomTasksUpdate: (state: { tasks: Task[] }) => void;
    onPartnerPresenceUpdate?: (state: PresenceState & { userId: string }) => void;
    onChatMessage?: (message: ChatMessage) => void;
    onYouTubeSync?: (url: string) => void;
    onAudioSync?: (provider: AudioProvider, url: string) => void;
    onReaction?: (reaction: { userId: string; emoji: string }) => void;
    onRemoved?: (userId: string) => void;
    onBye?: (userId: string) => void;
    onNotice?: (kind: string) => void;
    onHostChanged?: (hostId: string, name: string) => void;
    onRoomEnded?: () => void;
}
export interface ProfileStats {
    savedTotalSeconds: number; savedTodaySeconds: number; weekSeconds: number[]; persistedIds: string[];
    streak: number; sessionsCompleted: number; tasksCompleted: number;
    totalMinutes: number; todayMinutes: number; liveMinutes: number;
}
interface Session { id: string; user_id: string; room_id: string; mode: string; duration_seconds: number; completed_at: string; }
interface Room { id: string; room_code: string; is_locked: boolean; pin: string | null; created_at: string; created_by?: string | null; host_away?: boolean; acting_host?: string | null; }
export interface GroupDetails { host_name: string; topic: string; subject: string; camera: string; vibe: string; seats: number; }
export interface OpenRoom extends GroupDetails { id: string; host_id: string; seats_taken: number; closed: boolean; timer_mode: string | null; timer_ends_at: string | null; last_seen: string; away_until?: string | null; acting_name?: string | null; }
export interface PlannedGroup extends GroupDetails { id: string; host_id: string; starts_at: string; going: number; }
interface Profile { id: string; display_name: string | null; created_at: string; updated_at: string; }
type Table<Row, Insert = Partial<Row>> = { Row: { [K in keyof Row]: Row[K] }; Insert: { [K in keyof Insert]: Insert[K] }; Update: Partial<{ [K in keyof Row]: Row[K] }>; Relationships: [] };
export interface Database {
    public: {
        Tables: {
            tasks: Table<Omit<Task, 'pending'>>;
            sessions: Table<Session>;
            rooms: Table<Room>;
            profiles: Table<Profile>;
            open_rooms: Table<OpenRoom & { room_id: string }, Omit<OpenRoom, 'id' | 'last_seen'> & { room_id: string }>;
            planned_groups: Table<PlannedGroup, Omit<PlannedGroup, 'id' | 'going'>>;
            planned_group_members: Table<{ group_id: string; user_id: string }, { group_id: string }>;
            reports: Table<{ kind: string; target: string; topic: string | null; reason: string | null }>;
        };
        Views: Record<string, never>;
        Functions: {
            join_room: { Args: { p_room_code: string; p_pin: string }; Returns: string };
            join_open_room: { Args: { p_listing: string }; Returns: string };
            remove_participant: { Args: { p_room: string; p_user: string }; Returns: undefined };
            room_send: { Args: { p_room: string; p_event: string; p_payload: Record<string, unknown> }; Returns: undefined };
            transfer_host: { Args: { p_room: string; p_user: string }; Returns: string };
            end_room: { Args: { p_room: string }; Returns: undefined };
            step_away: { Args: { p_room: string }; Returns: undefined };
            claim_host: { Args: { p_room: string }; Returns: boolean };
            release_host: { Args: { p_room: string }; Returns: undefined };
            room_checkin: { Args: { p_room: string; p_seats_taken: number; p_timer_mode: string | null; p_timer_ends_at: string | null }; Returns: boolean };
            lists_room: { Args: { p_room: string }; Returns: boolean };
        };
        Enums: Record<string, never>;
        CompositeTypes: Record<string, never>;
    };
}
