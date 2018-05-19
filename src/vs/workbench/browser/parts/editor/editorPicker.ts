/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import 'vs/css!./media/editorpicker';
import { TPromise } from 'vs/base/common/winjs.base';
import * as nls from 'vs/nls';
import URI from 'vs/base/common/uri';
import { IIconLabelValueOptions } from 'vs/base/browser/ui/iconLabel/iconLabel';
import { IAutoFocus, Mode, IEntryRunContext, IQuickNavigateConfiguration, IModel } from 'vs/base/parts/quickopen/common/quickOpen';
import { QuickOpenModel, QuickOpenEntry, QuickOpenEntryGroup, QuickOpenItemAccessor } from 'vs/base/parts/quickopen/browser/quickOpenModel';
import { IModeService } from 'vs/editor/common/services/modeService';
import { getIconClasses } from 'vs/workbench/browser/labels';
import { IModelService } from 'vs/editor/common/services/modelService';
import { QuickOpenHandler } from 'vs/workbench/browser/quickopen';
import { INextEditorService } from 'vs/workbench/services/editor/common/nextEditorService';
import { INextEditorGroupsService, INextEditorGroup, EditorsOrder, GroupsOrder } from 'vs/workbench/services/group/common/nextEditorGroupsService';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { EditorInput, toResource } from 'vs/workbench/common/editor';
import { compareItemsByScore, scoreItem, ScorerCache, prepareQuery } from 'vs/base/parts/quickopen/common/quickOpenScorer';

export class EditorPickerEntry extends QuickOpenEntryGroup {

	constructor(
		private editor: EditorInput,
		private _group: INextEditorGroup,
		@IModeService private modeService: IModeService,
		@IModelService private modelService: IModelService
	) {
		super();
	}

	public getLabelOptions(): IIconLabelValueOptions {
		return {
			extraClasses: getIconClasses(this.modelService, this.modeService, this.getResource()),
			italic: !this._group.isPinned(this.editor)
		};
	}

	public getLabel(): string {
		return this.editor.getName();
	}

	public getIcon(): string {
		return this.editor.isDirty() ? 'dirty' : '';
	}

	public get group(): INextEditorGroup {
		return this._group;
	}

	public getResource(): URI {
		return toResource(this.editor, { supportSideBySide: true });
	}

	public getAriaLabel(): string {
		return nls.localize('entryAriaLabel', "{0}, editor group picker", this.getLabel());
	}

	public getDescription(): string {
		return this.editor.getDescription();
	}

	public run(mode: Mode, context: IEntryRunContext): boolean {
		if (mode === Mode.OPEN) {
			return this.runOpen(context);
		}

		return super.run(mode, context);
	}

	private runOpen(context: IEntryRunContext): boolean {
		this._group.openEditor(this.editor);

		return true;
	}
}

export abstract class BaseEditorPicker extends QuickOpenHandler {
	private scorerCache: ScorerCache;

	constructor(
		@IInstantiationService protected instantiationService: IInstantiationService,
		@INextEditorService protected editorService: INextEditorService,
		@INextEditorGroupsService protected editorGroupService: INextEditorGroupsService
	) {
		super();

		this.scorerCache = Object.create(null);
	}

	public getResults(searchValue: string): TPromise<QuickOpenModel> {
		const editorEntries = this.getEditorEntries();
		if (!editorEntries.length) {
			return TPromise.as(null);
		}

		// Prepare search for scoring
		const query = prepareQuery(searchValue);

		const entries = editorEntries.filter(e => {
			if (!query.value) {
				return true;
			}

			const itemScore = scoreItem(e, query, true, QuickOpenItemAccessor, this.scorerCache);
			if (!itemScore.score) {
				return false;
			}

			e.setHighlights(itemScore.labelMatch, itemScore.descriptionMatch);

			return true;
		});

		// Sorting
		if (query.value) {
			const groups = this.editorGroupService.getGroups(GroupsOrder.CREATION_TIME);
			entries.sort((e1, e2) => {
				if (e1.group !== e2.group) {
					return groups.indexOf(e1.group) - groups.indexOf(e2.group); // older groups first
				}

				return compareItemsByScore(e1, e2, query, true, QuickOpenItemAccessor, this.scorerCache);
			});
		}

		// Grouping (for more than one group)
		if (this.editorGroupService.count > 1) {
			let lastGroup: INextEditorGroup;
			entries.forEach(e => {
				if (!lastGroup || lastGroup !== e.group) {
					e.setGroupLabel(e.group.label);
					e.setShowBorder(!!lastGroup);
					lastGroup = e.group;
				}
			});
		}

		return TPromise.as(new QuickOpenModel(entries));
	}

	public onClose(canceled: boolean): void {
		this.scorerCache = Object.create(null);
	}

	protected abstract getEditorEntries(): EditorPickerEntry[];
}

export class ActiveEditorGroupPicker extends BaseEditorPicker {

	public static readonly ID = 'workbench.picker.activeEditors';

	protected getEditorEntries(): EditorPickerEntry[] {
		return this.group.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).map((editor, index) => this.instantiationService.createInstance(EditorPickerEntry, editor, this.group));
	}

	private get group(): INextEditorGroup {
		return this.editorGroupService.activeGroup;
	}

	public getEmptyLabel(searchString: string): string {
		if (searchString) {
			return nls.localize('noResultsFoundInGroup', "No matching opened editor found in group");
		}

		return nls.localize('noOpenedEditors', "List of opened editors is currently empty in group");
	}

	public getAutoFocus(searchValue: string, context: { model: IModel<QuickOpenEntry>, quickNavigateConfiguration?: IQuickNavigateConfiguration }): IAutoFocus {
		if (searchValue || !context.quickNavigateConfiguration) {
			return {
				autoFocusFirstEntry: true
			};
		}

		const isShiftNavigate = (context.quickNavigateConfiguration && context.quickNavigateConfiguration.keybindings.some(k => {
			const [firstPart, chordPart] = k.getParts();
			if (chordPart) {
				return false;
			}

			return firstPart.shiftKey;
		}));

		if (isShiftNavigate) {
			return {
				autoFocusLastEntry: true
			};
		}

		const editors = this.group.count;
		return {
			autoFocusFirstEntry: editors === 1,
			autoFocusSecondEntry: editors > 1
		};
	}
}

export class AllEditorsPicker extends BaseEditorPicker {

	public static readonly ID = 'workbench.picker.editors';

	protected getEditorEntries(): EditorPickerEntry[] {
		const entries: EditorPickerEntry[] = [];

		this.editorGroupService.groups.forEach(group => {
			group.editors.forEach(editor => {
				entries.push(this.instantiationService.createInstance(EditorPickerEntry, editor, group));
			});
		});

		return entries;
	}

	public getEmptyLabel(searchString: string): string {
		if (searchString) {
			return nls.localize('noResultsFound', "No matching opened editor found");
		}

		return nls.localize('noOpenedEditorsAllGroups', "List of opened editors is currently empty");
	}

	public getAutoFocus(searchValue: string, context: { model: IModel<QuickOpenEntry>, quickNavigateConfiguration?: IQuickNavigateConfiguration }): IAutoFocus {
		if (searchValue) {
			return {
				autoFocusFirstEntry: true
			};
		}

		return super.getAutoFocus(searchValue, context);
	}
}