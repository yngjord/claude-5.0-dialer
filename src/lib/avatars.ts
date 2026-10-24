import { useEffect, useState } from 'react';
import type { DialerUser } from '../../shared/types';
import { supabase } from './supabase';

export const AVATAR_BUCKET = 'dialer-avatars';
const SIZE = 256;

const isStoragePath = (v: string | null | undefined): v is string => !!v && !/^https?:\/\//i.test(v);

/**
 * Display URLs for team profile pictures, by user id. Pictures in the private bucket get short-lived signed URLs
 * (one request for everyone); full links to images hosted elsewhere are used as they are.
 */
export function useAvatarUrls(users: DialerUser[] | null | undefined): Map<string, string> {
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const key = (users ?? []).map((u) => `${u.id}:${u.avatar_url ?? ''}`).join('|');

  useEffect(() => {
    let cancelled = false;
    const list = users ?? [];
    const next = new Map<string, string>();
    list.forEach((u) => u.avatar_url && !isStoragePath(u.avatar_url) && next.set(u.id, u.avatar_url));
    const stored = list.filter((u) => isStoragePath(u.avatar_url));
    if (!stored.length) {
      setUrls(next);
      return;
    }
    supabase.storage
      .from(AVATAR_BUCKET)
      .createSignedUrls(
        stored.map((u) => u.avatar_url as string),
        60 * 60,
      )
      .then(({ data }) => {
        if (cancelled) return;
        data?.forEach((d, i) => d.signedUrl && next.set(stored[i].id, d.signedUrl));
        setUrls(next);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return urls;
}

/** Crops the image to a centred square and shrinks it to 256px JPEG, so pictures stay small and load quickly. */
async function toSquareJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read that image.'))), 'image/jpeg', 0.9));
}

/** Uploads a new profile picture for a team member (admins only) and removes their previous one. */
export async function uploadAvatar(user: DialerUser, file: File): Promise<void> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (JPG, PNG or WebP).');
  const blob = await toSquareJpeg(file);
  const path = `${user.id}/${Date.now()}.jpg`;
  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw new Error(error.message);
  const { error: setError } = await supabase.rpc('dialer_set_avatar', { p_user_id: user.id, p_avatar: path });
  if (setError) throw new Error(setError.message);
  if (isStoragePath(user.avatar_url)) await supabase.storage.from(AVATAR_BUCKET).remove([user.avatar_url]);
}

export async function removeAvatar(user: DialerUser): Promise<void> {
  const { error } = await supabase.rpc('dialer_set_avatar', { p_user_id: user.id, p_avatar: null });
  if (error) throw new Error(error.message);
  if (isStoragePath(user.avatar_url)) await supabase.storage.from(AVATAR_BUCKET).remove([user.avatar_url]);
}
