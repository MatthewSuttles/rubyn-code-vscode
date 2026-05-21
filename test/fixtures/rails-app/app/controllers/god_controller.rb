class GodController < ApplicationController
  def index
    @users = User.all
  end

  def show
    @user = User.find(params[:id])
    if @user.active
      @posts = @user.posts
      @comments = @user.comments
    else
      @posts = []
      @comments = []
    end
  end

  def new
    @user = User.new
  end

  def create
    @user = User.new(user_params)
    if @user.save
      Notifier.welcome(@user).deliver_later
      AuditLog.create!(action: "create_user", subject: @user)
      Cache.invalidate("users_list")
      redirect_to @user
    else
      render :new
    end
  end

  def edit
    @user = User.find(params[:id])
  end

  def update
    @user = User.find(params[:id])
    if @user.update(user_params)
      Notifier.updated(@user).deliver_later
      AuditLog.create!(action: "update_user", subject: @user)
      redirect_to @user
    else
      render :edit
    end
  end

  def destroy
    @user = User.find(params[:id])
    Notifier.farewell(@user).deliver_later
    AuditLog.create!(action: "destroy_user", subject: @user)
    BackgroundJob.enqueue(:cleanup, user_id: @user.id)
    @user.destroy!
    redirect_to users_path
  end

  def search
    @results = SearchService.run(params[:q]) || []
  end

  def export
    @report = ReportBuilder.new(User.active).build || []
    ExportLog.create!(report: @report.id)
  end

  def import
    @batch = ImportService.run(params[:file])
    if @batch.success?
      AuditLog.create!(action: "import_users", subject: @batch)
      redirect_to users_path
    else
      render :import_form
    end
  end

  def archive
    @user = User.find(params[:id])
    Archiver.run(@user)
    AuditLog.create!(action: "archive_user", subject: @user)
  end

  def restore
    @user = ArchivedUser.find(params[:id])
    @user.restore!
  end

  def promote
    @user = User.find(params[:id])
    @user.update!(role: "admin")
    AuditLog.create!(action: "promote", subject: @user)
  end

  def demote
    @user = User.find(params[:id])
    @user.update!(role: "member")
    AuditLog.create!(action: "demote", subject: @user)
  end

  def lock
    @user = User.find(params[:id])
    @user.update!(locked_at: Time.current)
  end

  def unlock
    @user = User.find(params[:id])
    @user.update!(locked_at: nil)
  end

  def big_branchy_method(x)
    if x.nil?
      :nil
    elsif x < 0
      :neg
    elsif x == 0
      :zero
    elsif x < 10
      :small
    elsif x < 100
      :medium
    elsif x < 1000
      :large
    else
      :huge
    end || :fallback
  rescue StandardError
    :err
  end

  private

  def user_params
    params.require(:user).permit(:name, :email, :role)
  end
end
