import type { SignalMessage, RemoteStream } from '../types';
import { sendSignal, getMyUserId } from './socket';
import { api } from './api';

let localStream: MediaStream | null = null;
let mediaGeneration = 0;
const peers: Record<string, RTCPeerConnection> = {};
const makingOffer: Record<string, boolean> = {};
const candidateQueues: Record<string, RTCIceCandidateInit[]> = {};
// A real negotiation produces a few dozen candidates. Past this many from one
// peer, the rest are ignored, so a flood cannot tie up the browser's ICE agent.
const MAX_CANDIDATES_PER_PEER = 200;
const candidateCounts: Record<string, number> = {};
const pendingPeers: Partial<Record<string, Promise<RTCPeerConnection>>> = {};
const remoteStreams: Record<string, MediaStream> = {};

const DEFAULT_ICE: RTCConfiguration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
    ]
};

let iceConfig = { ...DEFAULT_ICE };
let fetchTurnPromise: Promise<void> | null = null;
let hasRelay = false;

// Hide my IP: calls go through the relay (TURN) server, so this browser only ever
// offers the relay's address and the people in the room never learn its own.
// Costs a little delay. Applies to calls set up after it changes.
let hideIp = false;
export const setHideIp = (on: boolean) => { hideIp = on; };
let onRelayUnavailable: (() => void) | undefined;
export const whenRelayUnavailable = (run: () => void) => { onRelayUnavailable = run; };
let warnedNoRelay = false;

const serializeCandidate = (candidate: RTCIceCandidate | null) => {
    if (!candidate) return null;
    if (typeof candidate.toJSON === 'function') return candidate.toJSON();
    return {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment
    };
};

const fetchTurnCredentials = async () => {
    if (fetchTurnPromise) return fetchTurnPromise;
    fetchTurnPromise = (async () => {
        try {
            const response = await api('/api/turn-credentials', {}, 5000);
            if (!response.ok) return;
            const data = await response.json();
            if (Array.isArray(data.iceServers) && data.iceServers.length) {
                hasRelay = data.iceServers.some((server: RTCIceServer) => [server.urls].flat().some(url => /^turns?:/.test(String(url))));
                iceConfig = {
                    iceServers: [...(DEFAULT_ICE.iceServers || []), ...data.iceServers]
                };
            }
        } catch (e) {
            console.warn('TURN fetch failed, using STUN only.', e);
        } finally {
            // A failed fetch is not remembered, so the next call tries again.
            if (!hasRelay) fetchTurnPromise = null;
        }
    })();
    return fetchTurnPromise;
};

export const hasPeer = (userId: string) => !!peers[userId];
// True only while media is actually flowing to this person.
export const isPeerConnected = (userId: string) => peers[userId]?.connectionState === 'connected';

// 'disconnected' is a normal transient ICE blip that usually self-recovers
// in a second or two — tearing down on it immediately just recreates the
// flicker this is meant to fix. Only treat it as broken once it's been
// stuck for a while.
const DISCONNECT_GRACE_MS = 6000;
const disconnectedSince: Record<string, number> = {};

export const peerNeedsCall = (userId: string) => {
    const pc = peers[userId];
    if (!pc) return true;
    const state = pc.connectionState;
    if (state === 'failed' || state === 'closed') return true;
    return state === 'disconnected' && Date.now() - (disconnectedSince[userId] || Date.now()) > DISCONNECT_GRACE_MS;
};

export let isDummyMedia = false;

let dummyRAFId: number | null = null;
let dummyAudioCtx: AudioContext | null = null;
let dummyOscillator: OscillatorNode | null = null;

const createDummyStream = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d')!;

    const draw = () => {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, 1, 1);
        dummyRAFId = requestAnimationFrame(draw);
    };
    draw();

    const canvasStream = canvas.captureStream(15);

    dummyAudioCtx = new (window.AudioContext || window.webkitAudioContext!)();
    const destination = dummyAudioCtx.createMediaStreamDestination();
    dummyOscillator = dummyAudioCtx.createOscillator();
    const gainNode = dummyAudioCtx.createGain();
    gainNode.gain.value = 0;
    dummyOscillator.connect(gainNode);
    gainNode.connect(destination);
    dummyOscillator.start();

    return new MediaStream([
        canvasStream.getVideoTracks()[0],
        destination.stream.getAudioTracks()[0]
    ]);
};

export const cleanupDummyStream = () => {
    if (dummyRAFId) {
        cancelAnimationFrame(dummyRAFId);
        dummyRAFId = null;
    }
    if (dummyOscillator) {
        try { dummyOscillator.stop(); } catch (e) { /* already stopped */ }
        dummyOscillator = null;
    }
    if (dummyAudioCtx) {
        try { dummyAudioCtx.close(); } catch (e) { /* already closed */ }
        dummyAudioCtx = null;
    }
};

export const cleanupMedia = () => {
    mediaGeneration++;
    cleanupDummyStream();
    localStream?.getTracks().forEach(track => track.stop());
    localStream = null;
    Object.keys(peers).forEach(removePeer);
    document.querySelectorAll('video').forEach(video => { video.srcObject = null; });
};

export const initMedia = async (videoEl: HTMLVideoElement) => {
    const generation = ++mediaGeneration;
    isDummyMedia = false;
    try {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('getUserMedia unsupported');
        }

        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (e) {
            console.warn('Failed video+audio, trying fallbacks', e);
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            } catch (e2) {
                localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
                isDummyMedia = true;
            }
        }

        if (generation !== mediaGeneration) {
            localStream?.getTracks().forEach(track => track.stop());
            return false;
        }
        videoEl.srcObject = localStream;
        videoEl.muted = true;
        await videoEl.play().catch((err) => console.error('Autoplay failed:', err));
        return true;
    } catch (err) {
        if (generation !== mediaGeneration) return false;
        console.warn('Using dummy stream to keep WebRTC alive.', err);
        localStream = createDummyStream();
        isDummyMedia = true;
        videoEl.srcObject = localStream;
        videoEl.muted = true;
        await videoEl.play().catch((e) => console.error('Autoplay failed:', e));
        return true;
    }
};

// Returns the new enabled state, or null when there's no mic to toggle at
// all (e.g. getUserMedia fell back to video-only) — distinct from a
// successful toggle-to-muted, which also has no audio, so callers can tell
// "you muted yourself" apart from "there's no microphone to control".
export const toggleAudio = () => {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (!audioTrack) return null;
    audioTrack.enabled = !audioTrack.enabled;
    return audioTrack.enabled;
};

export const hasAudioTrack = () => !!localStream?.getAudioTracks()[0];

export const toggleVideo = () => {
    const videoTrack = localStream?.getVideoTracks()[0];
    if (!videoTrack || isDummyMedia) return false;
    videoTrack.enabled = !videoTrack.enabled;
    return videoTrack.enabled;
};

export const isVideoActive = () => {
    if (isDummyMedia) return false;
    const videoTrack = localStream?.getVideoTracks()[0];
    return !!(videoTrack && videoTrack.enabled && videoTrack.readyState === 'live');
};



export const getOrCreatePeerConnection = async (userId: string, onRemoteStream: RemoteStream) => {
    if (peers[userId] && peers[userId].signalingState !== 'closed') return peers[userId];
    if (pendingPeers[userId]) return pendingPeers[userId];

    pendingPeers[userId] = (async () => {
        const generation = mediaGeneration;
        await fetchTurnCredentials();
        if (generation !== mediaGeneration) throw new Error('Room media has been closed');
        // Fails closed: with the address to be hidden and no relay to hide it behind, the call
        // stays relay-only and simply doesn't connect, and the person is told how to choose.
        const relayOnly = hideIp;
        if (hideIp && !hasRelay && !warnedNoRelay) { warnedNoRelay = true; onRelayUnavailable?.(); }
        if (hasRelay) warnedNoRelay = false;
        const pc = new RTCPeerConnection({ ...iceConfig, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
        peers[userId] = pc;
        candidateQueues[userId] = candidateQueues[userId] || [];
        makingOffer[userId] = false;

        if (localStream) {
            localStream.getTracks().forEach((track) => {
                pc.addTrack(track, localStream!);
            });
        }

        pc.onicecandidate = (event) => {
            if (!event.candidate) return;
            // Belt and braces: in relay mode nothing but relay candidates ever leaves this browser.
            if (relayOnly && !/ typ relay/.test(event.candidate.candidate)) return;
            sendSignal(userId, { type: 'candidate', candidate: serializeCandidate(event.candidate) });
        };

        pc.ontrack = (event) => {
            let stream = remoteStreams[userId];
            if (!stream) {
                stream = new MediaStream();
                remoteStreams[userId] = stream;
            }
            stream.addTrack(event.track);

            if (event.track) {
                event.track.onunmute = () => onRemoteStream(userId, stream);
            }
            onRemoteStream(userId, stream);
        };

        pc.onconnectionstatechange = () => {
            console.log(`[WebRTC] ${userId}: ${pc.connectionState}`);
            if (pc.connectionState === 'disconnected') {
                if (!disconnectedSince[userId]) disconnectedSince[userId] = Date.now();
            } else {
                delete disconnectedSince[userId];
            }
        };

        return pc;
    })();

    try {
        return await pendingPeers[userId];
    } finally {
        delete pendingPeers[userId];
    }
};

const flushCandidates = async (userId: string, pc: RTCPeerConnection) => {
    const queued = candidateQueues[userId] || [];
    candidateQueues[userId] = [];
    for (const candidate of queued) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.warn('Failed to apply queued ICE candidate', err);
        }
    }
};

const isPolite = (remoteId: string) => {
    const mine = getMyUserId() || '';
    return mine > remoteId;
};

export const handleSignal = async (data: SignalMessage, onRemoteStream: RemoteStream) => {
    const { from, signal } = data || {};
    if (!from || !signal) return;

    try {
        const pc = await getOrCreatePeerConnection(from, onRemoteStream);
        if (!candidateQueues[from]) candidateQueues[from] = [];
        if (signal.type === 'offer') {
            const offerCollision = makingOffer[from] || pc.signalingState !== 'stable';
            if (offerCollision) {
                if (!isPolite(from)) return;
                try {
                    await pc.setLocalDescription({ type: 'rollback' });
                } catch (e) {
                    console.warn('Rollback skipped', e);
                }
            }

            await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal(from, { type: 'answer', answer: { type: answer.type, sdp: answer.sdp } });
            await flushCandidates(from, pc);
        } else if (signal.type === 'answer') {
            if (pc.signalingState !== 'have-local-offer') return;
            await pc.setRemoteDescription(new RTCSessionDescription(signal.answer));
            await flushCandidates(from, pc);
        } else if (signal.type === 'candidate' && signal.candidate) {
            candidateCounts[from] = (candidateCounts[from] || 0) + 1;
            if (candidateCounts[from] > MAX_CANDIDATES_PER_PEER) return;
            if (pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } else {
                candidateQueues[from].push(signal.candidate);
            }
        }
    } catch (err) {
        console.error('Signal handling error:', err);
    }
};

export const callUser = async (userId: string, onRemoteStream: RemoteStream) => {
    try {
        const pc = await getOrCreatePeerConnection(userId, onRemoteStream);
        if (pc.signalingState !== 'stable') return;
        if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') return;

        makingOffer[userId] = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(userId, { type: 'offer', offer: { type: offer.type, sdp: offer.sdp } });
    } catch (err) {
        console.error('Failed to initiate call:', err);
    } finally {
        makingOffer[userId] = false;
    }
};

export const removePeer = (userId: string) => {
    if (peers[userId]) {
        peers[userId].onicecandidate = null;
        peers[userId].ontrack = null;
        peers[userId].close();
        delete peers[userId];
    }
    delete makingOffer[userId];
    delete candidateQueues[userId];
    delete candidateCounts[userId];
    delete pendingPeers[userId];
    delete remoteStreams[userId];
    delete disconnectedSince[userId];
};
