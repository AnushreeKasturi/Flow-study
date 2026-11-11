// The fixed choices a group is described with. No browser or network code here,
// so page templates can import it at build time.
export const SUBJECTS = [
    ['maths', 'Maths'], ['science', 'Sciences'], ['programming', 'Programming'], ['languages', 'Languages'],
    ['writing', 'Writing'], ['exams', 'Exam prep'], ['other', 'Other']
] as const;
export const CAMERAS = [['optional', 'Cameras optional'], ['on', 'Cameras on'], ['off', 'Cameras off']] as const;
export const VIBES = [['quiet', 'Quiet'], ['chatty', 'Chatty']] as const;
export const labelOf = (list: readonly (readonly [string, string])[], id: string) => list.find(([value]) => value === id)?.[1] ?? '';
