import {
    IAtom,
    IDepTreeNode,
    IObservable,
    addObserver,
    fail,
    globalState,
    isComputedValue,
    removeObserver
} from "../internal"

/**
 * mobx整个系统是由ObservableValue, ComputedValue, Reaction这三个东西构建的
    ObservableValue 是最小的构成单位，ComputedValue是基于一个或多个ObservableValue构建的。
    Reaction则是由ObservableValue与ComputedValue驱动执行。
    假如有ObservableValue a,b，ComputedValue c是由a, b组成，那么当a发生变化时，它会让c计算自己的新值。
    如果c与Reaction d有关联，那么d也会执行。
    这种关系机制，通过依赖收集实现。但在极端的场景中，a,b可能会被重复收集，造成不必要的性能消耗。
    因此这些对象都有一个叫lowestObserverState的属性。
    ObservableValue的父类就是BaseAtom, 它在这里继承于lowestObserverState，值为IDerivationState.NOT_TRACKING， 即-1。
    ComputedValue没有继承BaseAtom或Atom，但结构与其他类差不多，lowestObserverState的值为IDerivationState.UP_TO_DATE，即为0
    它还有一个dependenciesState，IDerivationState.NOT_TRACKING，即-1
    Reaction没有lowestObserverState，只有dependenciesState，值为 IDerivationState.NOT_TRACKING，即-1
    IDerivationState还有两个状态，POSSIBLY_STALE，即1， 和STALE 2.

    状态值越高表示越不稳定
    我们可以将这四个状态翻译成
* IDerivationState.NOT_TRACKING：值为 -1，作为 derivation 的初始状态。当衍生不再订阅响应式数据时，derivation.dependenciesState 值也将被置为 NOT_TRACKING。
* IDerivationState.UP_TO_DATE：值为 0，当响应式数据变更且衍生有执行时，derivation.dependenciesState 状态将被置为 UP_TO_DATE。
* IDerivationState.POSSIBLY_STALE：值为 1，计算属性变更时，订阅计算属性的衍生状态将置为 POSSIBLY_STALE。若在 shouldCompute 函数执行环节，当确认计算属性的值未作变更时，derivation.dependenciesState 状态将被重置为 UP_TO_DATE；若作变更，状态将置为 STALE。
* IDerivationState.STALE：值为 2，当衍生订阅的响应式数据或计算属性变更时，derivation.dependenciesState 状态将被置为 STALE，意味着衍生的逻辑需要重新启动。
 */
export enum IDerivationState {
    // before being run or (outside batch and not being observed)
    // at this point derivation is not holding any data about dependency tree
    NOT_TRACKING = -1,
    // no shallow dependency changed since last computation
    // won't recalculate derivation
    // this is what makes mobx fast
    UP_TO_DATE = 0,
    // some deep dependency changed, but don't know if shallow dependency changed
    // will require to check first if UP_TO_DATE or POSSIBLY_STALE
    // currently only ComputedValue will propagate POSSIBLY_STALE
    //
    // having this state is second big optimization:
    // don't have to recompute on every dependency change, but only when it's needed
    POSSIBLY_STALE = 1,
    // A shallow dependency has changed since last computation and the derivation
    // will need to recompute when it's needed next.
    STALE = 2
}

export enum TraceMode {
    NONE,
    LOG,
    BREAK
}

/**
 * derivation 可以理解为实际消费 observable 的观察者，
 * 因此，observer 就是 derivation。
 * IDerivation 接口有两类实现，其一是作为反应的 Reaction 类，
 * 其二是作为计算属性的 ComputedValue 类。这两个类都实现了具体的 onBecomeStale 方法。
 * reaction.onBecomeStale 方法的表现是在所有响应式数据变更完成后，再对相关的衍生执行批处理操作，
 * 当然，在同一个批处理周期内，不会再对由 reaction 引起的衍生加以处理，
 * 这些衍生需要等待下一个批处理周期。ComputedValue 的特别之处是，它既是衍生，又是响应式数据。
 * 因此，computedValue.onBecomeStale 方法的执行时机是在其他反应调用 onBecomeStale 过程中，
 * 重新获取计算属性的值。
 * 
 * 状态标识更新流程为：
 *
 * 1、当初次添加 derivation 时，状态标识置为 NOT_TRACKING。（trackDerivedFunction 函数实现）
 * 2、当响应式数据更新，监听这个响应式数据的衍生包含 reaction，
 * 则将该 reaction 的状态置为 STALE；包含 computedValue，则将该 computedValue 状态置为 STALE，
 * 并通过 computedValue.onBecameStale 方法将订阅这个计算属性的反应 reaction 的状态置为 POSSIBLY_STALE。
 * （propagateChanged, propagatedMaybeChanged 函数实现）
 * 3、在事务 endBatch 阶段，在 reaction.runReaction 执行过程刷新 reaction 和 observable 的绑定关系，
 * 并将 reaction 的状态标识置为 NOT_TRACKING（当用户端处理逻辑执行过程中，
 * reaction 订阅了新的 observable 时） 或 UP_TO_DATE。若 reaction 还订阅了计算属性，
 * 则调用计算属性 computedValue.get 方法，通过这个方法的执行，
 * 刷新 computedValue 和 observable 的关系，并将其状态标识置为 NOT_TRACKING 或 UP_TO_DATE。
 * （trackDerivedFunction 函数实现）
 */
/**
 * A derivation is everything that can be derived from the state (all the atoms) in a pure manner.
 * See https://medium.com/@mweststrate/becoming-fully-reactive-an-in-depth-explanation-of-mobservable-55995262a254#.xvbh6qd74
 */
export interface IDerivation extends IDepTreeNode {
    /**
     * 1、observing 属性为本次衍生在哪些响应式数据变更时执行。
     * 2、dependenciesState 属性为状态标识(代表观察者状态)，用于标记本次衍生观察的数据是否已经改变，是否运行期处理逻辑。
     * 3、onBecomeStale 方法就是当观察数据变更时，运行的处理逻辑。
     * 4、newObserving 属性用于变更 observable, derivation 的依赖关系（在于观察者可改变观察的数据）。
     * 5、unboundDepsCount 属性用于统计本次衍生所观察的数据量，同 observable.diffValue 一样，目的都在于实时更新 observable, derivation 的依赖关系。
     * 6、runId 属性，由它构成 observable.lastAcessedBy 的值。
     * 7、isTracing 属性标记日志级别，以便在 onBecomeStale 方法执行前打印日志。
     */
    observing: IObservable[]
    newObserving: null | IObservable[]
    dependenciesState: IDerivationState
    /**
     * Id of the current run of a derivation. Each time the derivation is tracked
     * this number is increased by one. This number is globally unique
     */
    runId: number
    /**
     * amount of dependencies used by the derivation in this run, which has not been bound yet.
     */
    unboundDepsCount: number
    __mapid: string
    onBecomeStale(): void
    isTracing: TraceMode

    /**
     *  warn if the derivation has no dependencies after creation/update
     */
    requiresObservable?: boolean
}

export class CaughtException {
    constructor(public cause: any) {
        // Empty
    }
}

export function isCaughtException(e: any): e is CaughtException {
    return e instanceof CaughtException
}

/**
 * Finds out whether any dependency of the derivation has actually changed.
 * If dependenciesState is 1 then it will recalculate dependencies,
 * if any dependency changed it will propagate it by changing dependenciesState to 2.
 *
 * By iterating over the dependencies in the same order that they were reported and
 * stopping on the first change, all the recalculations are only called for ComputedValues
 * that will be tracked by derivation. That is because we assume that if the first x
 * dependencies of the derivation doesn't change then the derivation should run the same way
 * up until accessing x-th dependency.
 */
export function shouldCompute(derivation: IDerivation): boolean {
    switch (derivation.dependenciesState) {
        case IDerivationState.UP_TO_DATE:
            return false
        case IDerivationState.NOT_TRACKING:
        case IDerivationState.STALE:
            return true
        case IDerivationState.POSSIBLY_STALE: {
            // state propagation can occur outside of action/reactive context #2195
            const prevAllowStateReads = allowStateReadsStart(true)
            const prevUntracked = untrackedStart() // no need for those computeds to be reported, they will be picked up in trackDerivedFunction.
            const obs = derivation.observing,
                l = obs.length
            for (let i = 0; i < l; i++) {
                const obj = obs[i]
                if (isComputedValue(obj)) {
                    if (globalState.disableErrorBoundaries) {
                        obj.get()
                    } else {
                        try {
                            obj.get()
                        } catch (e) {
                            // we are not interested in the value *or* exception at this moment, but if there is one, notify all
                            untrackedEnd(prevUntracked)
                            allowStateReadsEnd(prevAllowStateReads)
                            return true
                        }
                    }
                    // if ComputedValue `obj` actually changed it will be computed and propagated to its observers.
                    // and `derivation` is an observer of `obj`
                    // invariantShouldCompute(derivation)
                    if ((derivation.dependenciesState as any) === IDerivationState.STALE) {
                        untrackedEnd(prevUntracked)
                        allowStateReadsEnd(prevAllowStateReads)
                        return true
                    }
                }
            }
            changeDependenciesStateTo0(derivation)
            untrackedEnd(prevUntracked)
            allowStateReadsEnd(prevAllowStateReads)
            return false
        }
    }
}

// function invariantShouldCompute(derivation: IDerivation) {
//     const newDepState = (derivation as any).dependenciesState

//     if (
//         process.env.NODE_ENV === "production" &&
//         (newDepState === IDerivationState.POSSIBLY_STALE ||
//             newDepState === IDerivationState.NOT_TRACKING)
//     )
//         fail("Illegal dependency state")
// }

export function isComputingDerivation() {
    return globalState.trackingDerivation !== null // filter out actions inside computations
}

export function checkIfStateModificationsAreAllowed(atom: IAtom) {
    const hasObservers = atom.observers.size > 0
    // Should never be possible to change an observed observable from inside computed, see #798
    if (globalState.computationDepth > 0 && hasObservers)
        fail(
            process.env.NODE_ENV !== "production" &&
                `Computed values are not allowed to cause side effects by changing observables that are already being observed. Tried to modify: ${
                    atom.name
                }`
        )
    // Should not be possible to change observed state outside strict mode, except during initialization, see #563
    if (!globalState.allowStateChanges && (hasObservers || globalState.enforceActions === "strict"))
        fail(
            process.env.NODE_ENV !== "production" &&
                (globalState.enforceActions
                    ? "Since strict-mode is enabled, changing observed observable values outside actions is not allowed. Please wrap the code in an `action` if this change is intended. Tried to modify: "
                    : "Side effects like changing state are not allowed at this point. Are you trying to modify state from, for example, the render function of a React component? Tried to modify: ") +
                    atom.name
        )
}

export function checkIfStateReadsAreAllowed(observable: IObservable) {
    if (
        process.env.NODE_ENV !== "production" &&
        !globalState.allowStateReads &&
        globalState.observableRequiresReaction
    ) {
        console.warn(`[mobx] Observable ${observable.name} being read outside a reactive context`)
    }
}

/**
 * trackDerivedFunction 函数在 mobx 中的实际调用过程为：
 * 1、Reaction 构造函数提供了 track 实例方法。该实例方法执行过程中，
 *    将调用 trackDerivedFunction 函数更新 derivation 的状态和依赖关系，
 *    同时执行传参 fn 用户端执行逻辑。实际在构造 Reaction 过程中，
 *    用户端执行逻辑将经由 reaction.track 封装后构成 reaction.onInvalidate 方法，
 *    该方法将在 reaction.runReaction 执行过程中得到调用。这样就解释了响应式数据变更时，
 *    既会处理用户端执行逻辑，如使视图重绘，又会促使 reaction 的状态值和依赖关系得到更新。
 * 2、ComputedValue 构造函数提供的 computeValue 实例方法，也会调用 trackDerivedFunction 函数。
 *    而 computedValue.get 实例方法将间接调用 computeValue 方法，从而使计算属性的状态得到更新。 
 */
/**
 * Executes the provided function `f` and tracks which observables are being accessed.
 * The tracking information is stored on the `derivation` object and the derivation is registered
 * as observer of any of the accessed observables.
 */
export function trackDerivedFunction<T>(derivation: IDerivation, f: () => T, context: any) {
    const prevAllowStateReads = allowStateReadsStart(true)
    // pre allocate array allocation + room for variation in deps
    // array will be trimmed by bindDependencies
    // 把 derivation.dependenciesState 和 derivation.observing数组内所有 ob.lowestObserverState 改为 IDerivationState.UP_TO_DATE （0）
    // 先调用 changeDependenciesStateTo0 方法将 derivation 和 observing 置为稳定态 UP_TO_DATE，主要是方便后续判断是否处在收集依赖阶段
    changeDependenciesStateTo0(derivation)
    // 提前为新 observing 申请空间，之后会trim
    derivation.newObserving = new Array(derivation.observing.length + 100)
    // unboundDepsCount记录尚未绑定的数量，observable被观察者观察时通过reportObserved()更新值
    derivation.unboundDepsCount = 0
    derivation.runId = ++globalState.runId
    // 保存Reaction上下文，将当前进行的reaction赋值给globalState.trackingDerivation供bindDependencies依赖收集用
    const prevTracking = globalState.trackingDerivation
    globalState.trackingDerivation = derivation
    let result
    if (globalState.disableErrorBoundaries === true) {
        result = f.call(context)
    } else {
        try {
            // 这一步将会触发 observable 的访问(因为f中会访问可观察对象的属性)，
            // 即我们 ob.name --> $mobx.name.get() (ObservableValue.prototype.get)
            // -->reportObserved(ObservableValue)
            
            //调用track参数中的函数,在mobx-react里就是组件的render方法
            result = f.call(context)
        } catch (e) {
            result = new CaughtException(e)
        }
    }
    //恢复Reaction上下文
    globalState.trackingDerivation = prevTracking
    //Reaction跟Observable建立关系
    bindDependencies(derivation)

    warnAboutDerivationWithoutDependencies(derivation)

    allowStateReadsEnd(prevAllowStateReads)

    return result
}

function warnAboutDerivationWithoutDependencies(derivation: IDerivation) {
    if (process.env.NODE_ENV === "production") return

    if (derivation.observing.length !== 0) return

    if (globalState.reactionRequiresObservable || derivation.requiresObservable) {
        console.warn(
            `[mobx] Derivation ${
                derivation.name
            } is created/updated without reading any observable value`
        )
    }
}

/**
 * 
 * 刷新 derivation 和 observable 的依赖关系，
 * 并将 derivation 的状态标识置为 UP_TO_DATE 或 NOT_TRACKING
 */
/**
 * diffs newObserving with observing.
 * update observing to be newObserving with unique observables
 * notify observers that become observed/unobserved
 */
function bindDependencies(derivation: IDerivation) {
    // invariant(derivation.dependenciesState !== IDerivationState.NOT_TRACKING, "INTERNAL ERROR bindDependencies expects derivation.dependenciesState !== -1");
    // 暂存旧的observable列表
    const prevObserving = derivation.observing
    // 用新的observable列表替换旧的列表
    const observing = (derivation.observing = derivation.newObserving!)
    let lowestNewObservingDerivationState = IDerivationState.UP_TO_DATE

    // Go through all new observables and check diffValue: (this list can contain duplicates):
    //   0: first occurrence, change to 1 and keep it
    //   1: extra occurrence, drop it
    // 遍历所有新的observable，去除重复的observable
    let i0 = 0,
        l = derivation.unboundDepsCount
    for (let i = 0; i < l; i++) {
        // 这里实际上用了双指针方法去重，i0为慢指针，i为快指针
        const dep = observing[i]
        // 跳过重复的值，即diffValue 等于 1的值；当跳过重复的值时i与i0就不相等了，i领先于i0
        if (dep.diffValue === 0) {
            dep.diffValue = 1
            if (i0 !== i) observing[i0] = dep
            i0++
        }

        // Upcast is 'safe' here, because if dep is IObservable, `dependenciesState` will be undefined,
        // not hitting the condition
        if (((dep as any) as IDerivation).dependenciesState > lowestNewObservingDerivationState) {
            lowestNewObservingDerivationState = ((dep as any) as IDerivation).dependenciesState
        }
    }
    observing.length = i0

    derivation.newObserving = null // newObserving shouldn't be needed outside tracking (statement moved down to work around FF bug, see #614)

    // Go through all old observables and check diffValue: (it is unique after last bindDependencies)
    //   0: it's not in new observables, unobserve it
    //   1: it keeps being observed, don't want to notify it. change to 0
    // 遍历旧observable列表：
    // diffValue为0表示不在新的observable列表中（每一轮新的observables的diffValue都会被设置为1），在derivation中解除观察；
    // diffValue为1表示该值仍在被观察（每一轮的依赖更新时，假如一个可观察对象dep在之前一轮也在依赖列表中，
    // 此时dep对象是同一个，新的一轮更新newObserving依赖时，diffValue会被更新为1）；
    // 和newObserving去重操作一样巧妙，diffValue的作用很大呀
    l = prevObserving.length
    while (l--) {
        const dep = prevObserving[l]
        if (dep.diffValue === 0) {
            removeObserver(dep, derivation)
        }
        // 新旧遍历之后依旧将diffValue置0，即上面的 first occurrence
        dep.diffValue = 0
    }

    // Go through all new observables and check diffValue: (now it should be unique)
    //   0: it was set to 0 in last loop. don't need to do anything.
    //   1: it wasn't observed, let's observe it. set back to 0
    // 这里需要做这一步操作是因为第一步newObserving过滤后是新增的观察对象，
    // 第二步prevObserving将依赖的diffValue置0，但prevObserving中的依赖已经是addObserver()过的，
    // 所以就需要标记一下（diffValue置0），最后newObserving中的依赖diffValue为1的就进行addObserver()
    while (i0--) {
        const dep = observing[i0]
        if (dep.diffValue === 1) {
            dep.diffValue = 0
            // 给 observableValue 注册 observer
            // value change 时 observable(object, array, set...) 调用 this.atom.reportChanged() 发送通知
            // foreach 通知每个 reaction 调用 onBecomeStale，也就是 schedule 方法

            // 调用链路：value change --> observable设置值set(newVal) --> this.atom.reportChanged() 
            // --> propagateChanged(this) --> observable.observers.forEach调用observer.onBecomeStale() 
            // --> reaction.schedule() --> globalState.pendingReactions.push(this)以及runReactions() 
            // --> reactionScheduler() 
            // --> allReactions.forEach()执行每个reaction的reaction.runReaction() 
            // --> 执行每个reaction的this.onInvalidate()
            addObserver(dep, derivation)
        }
    }
    // NOTE: 收集完的依赖保存到 reaction.observing 中，在 getDependencyTree api 中会调用到

    // 对于新添加的观察数据，将 derivation 添加 globalState.pendingReactions 中，
    // 在当前事务周期中处理
    // Some new observed derivations may become stale during this derivation computation
    // so they have had no chance to propagate staleness (#916)
    if (lowestNewObservingDerivationState !== IDerivationState.UP_TO_DATE) {
        derivation.dependenciesState = lowestNewObservingDerivationState
        derivation.onBecomeStale()
    }
}

export function clearObserving(derivation: IDerivation) {
    // invariant(globalState.inBatch > 0, "INTERNAL ERROR clearObserving should be called only inside batch");
    const obs = derivation.observing
    derivation.observing = []
    let i = obs.length
    while (i--) removeObserver(obs[i], derivation)

    derivation.dependenciesState = IDerivationState.NOT_TRACKING
}

export function untracked<T>(action: () => T): T {
    const prev = untrackedStart()
    try {
        return action()
    } finally {
        untrackedEnd(prev)
    }
}

export function untrackedStart(): IDerivation | null {
    const prev = globalState.trackingDerivation
    globalState.trackingDerivation = null
    return prev
}

export function untrackedEnd(prev: IDerivation | null) {
    globalState.trackingDerivation = prev
}

export function allowStateReadsStart(allowStateReads: boolean) {
    const prev = globalState.allowStateReads
    globalState.allowStateReads = allowStateReads
    return prev
}

export function allowStateReadsEnd(prev: boolean) {
    globalState.allowStateReads = prev
}

/**
 * needed to keep `lowestObserverState` correct. when changing from (2 or 1) to 0
 *
 */
export function changeDependenciesStateTo0(derivation: IDerivation) {
    if (derivation.dependenciesState === IDerivationState.UP_TO_DATE) return
    derivation.dependenciesState = IDerivationState.UP_TO_DATE

    const obs = derivation.observing
    let i = obs.length
    // 将 observing 都置为 UP_TO_DATE，方便 computedValue 进行 shouldCompute 判断
    while (i--) obs[i].lowestObserverState = IDerivationState.UP_TO_DATE
}
