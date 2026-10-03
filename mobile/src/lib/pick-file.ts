import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

/**
 * Getting a file off a phone, from whichever of the three places it is.
 *
 * `log-flight.tsx` has had the camera and the photo library since squawk
 * photographs; records (SPEC Phase 2) adds the third, because a shop emails an
 * invoice as a PDF and the image picker cannot see one.
 *
 * **Source and kind are different questions.** Mockup 05's two tiles are
 * *kinds* — "Attach invoice", "Logbook entry" — and whether the file comes from
 * the camera or from Files is a *source*. Conflating them is how somebody ends
 * up unable to photograph an invoice, which is the common case: the paper one is
 * in their hand at the aeroplane.
 */

export type FileSource = 'camera' | 'library' | 'files';

export interface PickedFile {
  uri: string;
  contentType: string;
  /** What the picker called it, for a list that has to say something. */
  name?: string;
}

/**
 * How long to wait for the sheet that offered this choice to finish closing.
 *
 * `components/sheet.tsx` animates its dismissal over 200ms, and every call here
 * comes from inside one. iOS will not present a view controller from one that is
 * mid-transition: `UIDocumentPickerViewController` is simply never shown, with
 * no error and no rejected promise — the sheet closes and nothing happens, which
 * is precisely what it looked like.
 *
 * `expo-image-picker` survives the same race, which is why the camera and the
 * photo library appeared to work and this did not. One wait for all three, so
 * the picker that is most forgiving is not the only one that is correct.
 */
const SHEET_DISMISS_MS = 320;

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, SHEET_DISMISS_MS));

/**
 * Returns nothing when the person backed out or said no to the permission.
 *
 * Permission is asked at the moment it is needed rather than at launch, which
 * is the only version of the prompt that explains itself.
 *
 * Throws when the picker itself fails. The callers surface it: a file chooser
 * that does nothing and says nothing is indistinguishable from a broken button.
 */
export async function pickFile(source: FileSource): Promise<PickedFile | null> {
  await settle();

  if (source === 'files') {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/*'],
      // Into the app's cache, so `saveAttachment` can copy it somewhere it will
      // survive the queue. A content:// URI the system may revoke is not a file.
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset) return null;
    return {
      uri: asset.uri,
      contentType: asset.mimeType ?? contentTypeFromName(asset.name),
      ...(asset.name ? { name: asset.name } : {}),
    };
  }

  const granted =
    source === 'camera'
      ? (await ImagePicker.requestCameraPermissionsAsync()).granted
      : (await ImagePicker.requestMediaLibraryPermissionsAsync()).granted;
  if (!granted) return null;

  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(PHOTO_OPTIONS)
      : await ImagePicker.launchImageLibraryAsync(PHOTO_OPTIONS);
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    contentType: asset.mimeType ?? 'image/jpeg',
    ...(asset.fileName ? { name: asset.fileName } : {}),
  };
}

/**
 * Compressed, because the point is legibility and not resolution.
 *
 * A twelve-megapixel photograph of a paper invoice is forty times the bytes of
 * a readable one, and `storage.bytes` is the only limit on records (§8.3 keeps
 * the free tier real, which means not wasting it).
 */
const PHOTO_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  quality: 0.7,
  exif: false,
};

/** A fallback for a picker that returns a name and no type. */
function contentTypeFromName(name: string | undefined): string {
  const extension = name?.split('.').pop()?.toLowerCase();
  switch (extension) {
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'heic':
      return 'image/heic';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}
