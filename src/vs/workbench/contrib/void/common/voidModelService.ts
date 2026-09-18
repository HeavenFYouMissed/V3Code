/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
import { Disposable, IReference } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { EndOfLinePreference, ITextModel } from '../../../../editor/common/model.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextFileService, TextFileEditorModelState } from '../../../services/textfile/common/textfiles.js';

type VoidModelType = {
	model: ITextModel | null;
	editorModel: IResolvedTextEditorModel | null;
};

export interface IVoidModelService {
	readonly _serviceBrand: undefined;
	initializeModel(uri: URI): Promise<void>;
	refreshIfStale(uri: URI): Promise<void>;
	discardBuffer(uri: URI): Promise<void>;
	getModel(uri: URI): VoidModelType;
	getModelFromFsPath(fsPath: string): VoidModelType;
	getModelSafe(uri: URI): Promise<VoidModelType>;
	saveModel(uri: URI): Promise<void>;
	disposeModel(uri: URI): void;
}

export const IVoidModelService = createDecorator<IVoidModelService>('voidVoidModelService');

class VoidModelService extends Disposable implements IVoidModelService {
	_serviceBrand: undefined;
	static readonly ID = 'voidVoidModelService';
	private readonly _modelRefOfURI: Record<string, IReference<IResolvedTextEditorModel>> = {};

	constructor(
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ITextFileService private readonly _textFileService: ITextFileService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
	}

	saveModel = async (uri: URI) => {
		await this._textFileService.save(uri, { // we want [our change] -> [save] so it's all treated as one change.
			skipSaveParticipants: true // avoid triggering extensions etc (if they reformat the page, it will add another item to the undo stack)
		})
	}

	/**
	 * Drop a cached buffer that no longer describes the file on disk.
	 *
	 * A CLEAN model is meant to be a mirror of the file, so one that differs from disk is a ghost —
	 * most often a buffer that outlived a delete. Editing from it produces a diff computed against
	 * content that does not exist, which then gets written back as if it were an update: the file
	 * ends up holding a version nobody ever wrote, and every agent-facing read agrees with it
	 * because they all read the same buffer.
	 *
	 * A DIRTY model is the user's unsaved work and is left strictly alone. Disagreeing with disk is
	 * exactly what unsaved edits ARE, so reverting here would silently destroy them — a far worse
	 * bug than the one being fixed. That asymmetry is the whole point of the dirty check.
	 *
	 * The exception, and the reason this took three attempts: an ORPHANED model is dirty too.
	 * Deleting a file under an open buffer makes VS Code mark it dirty precisely so the contents
	 * are not lost, which means the ghost arrives wearing the same badge as work worth protecting.
	 * Orphan is therefore checked first — its file is gone, so there is nothing to preserve.
	 */
	refreshIfStale = async (uri: URI): Promise<void> => {
		// Orphaned first, because it is the case the dirty check cannot see. When a file is
		// deleted under an open buffer, VS Code marks that model DIRTY to protect its contents —
		// so "user has unsaved edits" and "this buffer describes a file that no longer exists"
		// are indistinguishable through isDirty alone, and guarding on dirty alone let the ghost
		// through. Measured three times: the diff kept reporting a removal of content that had
		// already been deleted.
		//
		// An orphan has no unsaved work worth keeping — the file it belonged to is gone — so it
		// is always safe to drop, and always wrong to keep.
		const fileModel = this._textFileService.files.get(uri);
		if (fileModel?.hasState(TextFileEditorModelState.ORPHAN)) {
			await this._textFileService.revert(uri);
			return;
		}
		if (this._textFileService.isDirty(uri)) {
			return;
		}
		const model = this._modelRefOfURI[uri.fsPath]?.object.textEditorModel;
		if (!model) {
			return;
		}
		let onDisk: string;
		try {
			onDisk = (await this._fileService.readFile(uri)).value.toString();
		} catch {
			return; // unreadable or gone — the write path reports that far better than we can here
		}
		if (onDisk.replace(/\r\n/g, '\n') === model.getValue(EndOfLinePreference.LF).replace(/\r\n/g, '\n')) {
			return;
		}
		// revert reloads from disk and leaves the model clean, unlike setValue which would mark it
		// dirty and make this look like an edit the user made.
		await this._textFileService.revert(uri);
	};

	/**
	 * Throw a buffer away and reload from disk, dirty or not.
	 *
	 * refreshIfStale deliberately refuses dirty models, and disposing one is not an option either:
	 * textFileEditorModelManager blocks disposal of a dirty model indefinitely to prevent data
	 * loss, and re-acquiring the reference cancels the pending dispose and returns the same buffer
	 * without re-reading disk. revert is the only call that actually moves a dirty model.
	 *
	 * Only for a path the caller can prove is a ghost — after our own delete. A buffer in that
	 * state cannot hold unsaved work belonging to the file now on disk, because the file it was
	 * in sync with no longer exists.
	 */
	discardBuffer = async (uri: URI): Promise<void> => {
		await this._textFileService.revert(uri);
	};

	initializeModel = async (uri: URI) => {
		try {
			if (uri.fsPath in this._modelRefOfURI) return;
			const editorModelRef = await this._textModelService.createModelReference(uri);
			// Keep a strong reference to prevent disposal
			this._modelRefOfURI[uri.fsPath] = editorModelRef;
		}
		catch (e) {
			console.log('InitializeModel error:', e)
		}
	};

	getModelFromFsPath = (fsPath: string): VoidModelType => {
		const editorModelRef = this._modelRefOfURI[fsPath];
		if (!editorModelRef) {
			return { model: null, editorModel: null };
		}

		const model = editorModelRef.object.textEditorModel;

		if (!model) {
			return { model: null, editorModel: editorModelRef.object };
		}

		return { model, editorModel: editorModelRef.object };
	};

	getModel = (uri: URI) => {
		return this.getModelFromFsPath(uri.fsPath)
	}


	getModelSafe = async (uri: URI): Promise<VoidModelType> => {
		if (!(uri.fsPath in this._modelRefOfURI)) await this.initializeModel(uri);
		return this.getModel(uri);
	};

	disposeModel = (uri: URI): void => {
		const ref = this._modelRefOfURI[uri.fsPath];
		if (ref) {
			ref.dispose();
			delete this._modelRefOfURI[uri.fsPath];
		}
	};

	override dispose() {
		super.dispose();
		for (const ref of Object.values(this._modelRefOfURI)) {
			ref.dispose(); // release reference to allow disposal
		}
	}
}

registerSingleton(IVoidModelService, VoidModelService, InstantiationType.Eager);
