import { Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { PlannerActions } from './planner.actions';
import {
  delay,
  exhaustMap,
  filter,
  first,
  map,
  mergeMap,
  switchMap,
  tap,
  withLatestFrom,
} from 'rxjs/operators';
import { PersistenceService } from '../../../core/persistence/persistence.service';
import { select, Store } from '@ngrx/store';
import { selectPlannerState } from './planner.selectors';
import { PlannerState } from './planner.reducer';
import {
  scheduleTask,
  unScheduleTask,
  updateTaskTags,
} from '../../tasks/store/task.actions';
import { EMPTY, merge } from 'rxjs';
import { TODAY_TAG } from '../../tag/tag.const';
import { unique } from '../../../util/unique';
import { selectTodayTaskIds } from '../../work-context/store/work-context.selectors';
import { MatDialog } from '@angular/material/dialog';
import { DialogAddPlannedTasksComponent } from '../dialog-add-planned-tasks/dialog-add-planned-tasks.component';
import { selectTasksById } from '../../tasks/store/task.selectors';
import { SyncTriggerService } from '../../../imex/sync/sync-trigger.service';
import { GlobalTrackingIntervalService } from '../../../core/global-tracking-interval/global-tracking-interval.service';
import { loadAllData } from '../../../root-store/meta/load-all-data.action';
import { selectTagById } from '../../tag/store/tag.reducer';
import { updateTag } from '../../tag/store/tag.actions';
import { PlannerService } from '../planner.service';
import { getAllMissingPlannedTaskIdsForDay } from '../util/get-all-missing-planned-task-ids-for-day';
import { devError } from '../../../util/dev-error';
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

  // TODO move to separate effect
  // MOVE BEFORE TASK
  // ---------------
  removeTodayTagForPlannedTaskFromSchedule$ = createEffect(() => {
    return this._actions$.pipe(
      ofType(PlannerActions.moveBeforeTask),
      filter(({ fromTask }) => fromTask.tagIds.includes(TODAY_TAG.id)),
      map(({ fromTask }) => {
        return updateTaskTags({
          task: fromTask,
          oldTagIds: fromTask.tagIds,
          newTagIds: fromTask.tagIds.filter((id) => id !== TODAY_TAG.id),
        });
      }),
    );
  });

  insertPlannedITaskIntoTodayList$ = createEffect(() => {
    return this._actions$.pipe(
      ofType(PlannerActions.moveBeforeTask),
      // filter(({ fromTask, toTaskId }) => fromTask.tagIds.includes(TODAY_TAG.id)),
      switchMap(({ fromTask, toTaskId }) => {
        return this._store.select(selectTagById, { id: TODAY_TAG.id }).pipe(
          first(),
          filter((todayTag) => todayTag.taskIds.includes(toTaskId)),
          mergeMap((todayTag) => {
            const newTaskIds = [...todayTag.taskIds].filter((id) => id !== fromTask.id);
            const toIndex = newTaskIds.indexOf(toTaskId);
            newTaskIds.splice(toIndex, 0, fromTask.id);
            return [
              updateTag({
                tag: {
                  id: TODAY_TAG.id,
                  changes: {
                    taskIds: unique(newTaskIds),
                  },
                },
                isSkipSnack: true,
              }),
              updateTaskTags({
                task: fromTask,
                oldTagIds: fromTask.tagIds,
                newTagIds: unique([TODAY_TAG.id, ...fromTask.tagIds]),
              }),
            ];
          }),
        );
      }),
    );
  });

  // INITIAL DIALOG
  // ---------------
  showDialogAfterAppLoad$ = createEffect(
    () => {
      return this._syncTriggerService.afterInitialSyncDoneAndDataLoadedInitially$.pipe(
        switchMap(() => {
          // check when reloading data
          return merge(
            this._actions$.pipe(
              ofType(loadAllData),
              switchMap(() =>
                this._globalTrackingIntervalService.todayDateStr$.pipe(first()),
              ),
            ),
            this._globalTrackingIntervalService.todayDateStr$.pipe(
              // wait a bit for other stuff as days$ might not be up-to-date
              delay(1400),
            ),
          );
        }),

        withLatestFrom(
          this._plannerService.days$,
          this._store.pipe(select(selectTodayTaskIds)),
          this._store.pipe(select(selectPlannerState)),
        ),
        exhaustMap(([todayStr, plannerDays, todayTaskIds, plannerState]) => {
          const plannerDay = plannerDays.find((day) => day.dayDate === todayStr);

          if (todayStr === plannerState.addPlannedTasksDialogLastShown) {
            return EMPTY;
          }

          if (!plannerDay) {
            devError('showDialogAfterAppLoad$(): No planner day found for today');
            // might possibly happen if feature was never used?
            return EMPTY;
          }

          const missingTaskIds = getAllMissingPlannedTaskIdsForDay(
            plannerDay,
            todayTaskIds,
          );

          if (missingTaskIds.length > 0) {
            return this._store.select(selectTasksById, { ids: missingTaskIds }).pipe(
              first(),
              exhaustMap((tasks) => {
                // NOTE: some tasks might not be there anymore since we don't do live updates to the planner model
                const existingTasks = tasks.filter((t) => !!t);
                if (existingTasks.length) {
                  return this._matDialog
                    .open(DialogAddPlannedTasksComponent, {
                      data: {
                        missingTasks: existingTasks,
                      },
                    })
                    .afterClosed()
                    .pipe(
                      // TODO add cleanup for plannerTasks
                      map(() =>
                        PlannerActions.updatePlannerDialogLastShown({ today: todayStr }),
                      ),
                    );
                } else {
                  console.log(
                    'Some tasks have been missing',
                    existingTasks,
                    missingTaskIds,
                  );
                  return EMPTY;
                }
              }),
            );
          } else {
            return EMPTY;
          }
        }),
      );
    },
    // { dispatch: false },
  );

  constructor(
    private _actions$: Actions,
    private _store: Store,
    private _persistenceService: PersistenceService,
    private _syncTriggerService: SyncTriggerService,
    private _matDialog: MatDialog,
    private _globalTrackingIntervalService: GlobalTrackingIntervalService,
    private _plannerService: PlannerService,
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
