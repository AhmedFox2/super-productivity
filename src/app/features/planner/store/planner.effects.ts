import { Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { PlannerActions } from './planner.actions';
import { filter, map, tap, withLatestFrom } from 'rxjs/operators';
import { PersistenceService } from '../../../core/persistence/persistence.service';
import { select, Store } from '@ngrx/store';
import { selectPlannerState } from './planner.selectors';
import { PlannerState } from './planner.reducer';
import {
  scheduleTask,
  unScheduleTask,
  updateTaskTags,
} from '../../tasks/store/task.actions';
import { TODAY_TAG } from '../../tag/tag.const';
import { unique } from '../../../util/unique';
import { getWorklogStr } from '../../../util/get-work-log-str';

@Injectable()
export class PlannerEffects {
  saveToDB$ = createEffect(
    () => {
      return this._actions$.pipe(
        ofType(
          PlannerActions.updatePlannerDialogLastShown,
          PlannerActions.upsertPlannerDay,
          PlannerActions.cleanupOldAndUndefinedPlannerTasks,
          PlannerActions.moveInList,
          PlannerActions.transferTask,
          PlannerActions.removeTaskFromDays,
          PlannerActions.planTaskForDay,
        ),
        withLatestFrom(this._store.pipe(select(selectPlannerState))),
        tap(([, plannerState]) => this._saveToLs(plannerState, true)),
      );
    },
    { dispatch: false },
  );

  // PLAN TASK FOR DAY
  // ---------------
  addTodayTagIfPlanedForToday$ = createEffect(() => {
    return this._actions$.pipe(
      ofType(PlannerActions.planTaskForDay),
      filter((action) => action.day === getWorklogStr()),
      map(({ task }) => {
        return updateTaskTags({
          task,
          oldTagIds: task.tagIds,
          newTagIds: unique([TODAY_TAG.id, ...task.tagIds]),
        });
      }),
    );
  });

  removeFromTodayIfPlannedForOtherDay$ = createEffect(() => {
    return this._actions$.pipe(
      ofType(PlannerActions.planTaskForDay),
      filter(({ task, day }) => day !== getWorklogStr()),
      map(({ task }) => {
        return updateTaskTags({
          task,
          oldTagIds: task.tagIds,
          newTagIds: task.tagIds.filter((id) => id !== TODAY_TAG.id),
        });
      }),
    );
  });

  // SCHEDULE RELATED
  // ---------------
  removeReminderForPlannedTask$ = createEffect(() => {
    return this._actions$.pipe(
      ofType(PlannerActions.planTaskForDay),
      filter(({ task, day }) => !!task.reminderId),
      map(({ task }) => {
        return unScheduleTask({
          id: task.id,
          reminderId: task.reminderId as string,
          isSkipToast: true,
        });
      }),
    );
  });

  removeOnSchedule$ = createEffect(() => {
    return this._actions$.pipe(
      ofType(scheduleTask),
      filter((action) => !!action.plannedAt),
      map(({ task }) => {
        return PlannerActions.removeTaskFromDays({
          taskId: task.id,
        });
      }),
    );
  });

  constructor(
    private _actions$: Actions,
    private _store: Store,
    private _persistenceService: PersistenceService,
  ) {}

  private _saveToLs(
    plannerState: PlannerState,
    isSyncModelChange: boolean = false,
  ): void {
    this._persistenceService.planner.saveState(plannerState, {
      isSyncModelChange,
    });
  }
}
