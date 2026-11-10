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
}
export interface ProfileStats {
    savedTotalSeconds: number; savedTodaySeconds: number; weekSeconds: number[]; persistedIds: string[];
    streak: number; sessionsCompleted: number; tasksCompleted: number;
    totalMinutes: number; todayMinutes: number; liveMinutes: number;
}
interface Session { id: string; user_id: string; room_id: string; mode: string; duration_seconds: number; completed_at: string; }
interface Room { id: string; room_code: string; is_locked: boolean; pin: string | null; created_at: string; }
interface Profile { id: string; display_name: string | null; created_at: string; updated_at: string; }
type Table<Row, Insert = Partial<Row>> = { Row: { [K in keyof Row]: Row[K] }; Insert: { [K in keyof Insert]: Insert[K] }; Update: Partial<{ [K in keyof Row]: Row[K] }>; Relationships: [] };
export interface Database {
    public: {
        Tables: {
            tasks: Table<Omit<Task, 'pending'>>;
            sessions: Table<Session>;
            rooms: Table<Room>;
            profiles: Table<Profile>;
        };
        Views: Record<string, never>;
        Functions: { join_room: { Args: { p_room_code: string; p_pin: string }; Returns: string } };
        Enums: Record<string, never>;
        CompositeTypes: Record<string, never>;
    };
}
